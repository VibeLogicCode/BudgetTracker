import { listCategories } from '@/lib/categories';
import { todayIso } from '@/lib/dates';
import { LocalAiAnswerError, LocalAiServerError, chatJson } from '@/lib/ai/client';
import {
  LOCAL_AI_UNREADABLE_LIMIT,
  localAiActive,
  readLocalAiConfig,
  recordLocalAiFailure,
  recordLocalAiSuccess,
  recordUnreadableAnswer,
} from '@/lib/ai/config';
import { merchantPrompt, receiptPrompt } from '@/lib/ai/prompts';
import { groundReceiptAnswer } from '@/lib/ai/receipt';
import { RECEIPT_ANSWER, categoryChoices, cleanMerchantName, merchantAnswer } from '@/lib/ai/schemas';
import { aiMerchantTargets, aiSuggestionFor, merchantPromptRow, recordMerchantFailure, recordMerchantSuggestion } from '@/lib/ai/suggestions';
import type { LocalAiConfig } from '@/lib/ai/types';
import { readAiSidecar, readSidecar, stagedByViewer, writeAiSidecar } from '@/lib/warranty/staging';

/**
 * v1.64.0 (plan 2026-11-12, A9). The local AI's work queue, in the OCR queue's shape
 * (src/lib/warranty/ocr/queue.ts): one in-process list, concurrency 1, a claimed-key set and one
 * pump. Household scale is a first import's few hundred merchants and a receipt now and then.
 *
 * - A receipt job goes to the front, behind other receipts only, because a person is waiting on it.
 * - At most AI_QUEUE_MAX_MERCHANT_JOBS merchant jobs are held; the next sweep tops it up.
 * - Before every job the pump asks localAiActive(now). Off, not set up or waiting after failures
 *   empties the queue and stops, so a server that is down is asked nothing until its wait is over.
 * - A server failure (LocalAiServerError, or the fifth unreadable answer in a row) is recorded once,
 *   empties the queue and stops. One unusable answer marks that merchant or receipt failed and the
 *   queue goes on.
 * - Nothing is logged that carries household data: a log line names the job kind and an error name.
 */

export type AiJob = { kind: 'merchant'; merchant: string } | { kind: 'receipt'; stagingId: string; userId: number };

export const AI_QUEUE_MAX_MERCHANT_JOBS = 100;
/** sweepAiWork asks for this many targets per tick (owner decision 10). */
export const AI_SWEEP_LIMIT = 100;

export const LOCAL_AI_SHAPE_ERROR = "The model's answer was not in the shape the app asked for.";
export const LOCAL_AI_NOTHING_USABLE_REASON = 'Nothing in the answer could be used.';
export const LOCAL_AI_UNREADABLE_STREAK_ERROR = `The model gave ${LOCAL_AI_UNREADABLE_LIMIT} unreadable answers in a row.`;

const queue: AiJob[] = [];
const claimed = new Set<string>();
let pump: Promise<void> | null = null;

function jobKey(job: AiJob): string {
  return job.kind === 'merchant' ? `m:${job.merchant}` : `r:${job.stagingId}`;
}

function merchantJobCount(): number {
  return queue.reduce((n, job) => (job.kind === 'merchant' ? n + 1 : n), 0);
}

export function aiQueueDepth(): number {
  return queue.length;
}

export function isAiJobClaimed(job: AiJob): boolean {
  return claimed.has(jobKey(job));
}

/**
 * Returns false when the job is already claimed (queued or running), or when it is a merchant job
 * and the queue already holds the most it may. The pump starts on the next microtask, so a burst
 * enqueued in one turn (a sweep, then a receipt) is ordered before the first job runs.
 */
export function enqueueAiJob(job: AiJob): boolean {
  const key = jobKey(job);
  if (claimed.has(key)) return false;
  if (job.kind === 'merchant') {
    if (typeof job.merchant !== 'string' || job.merchant.length === 0) return false;
    if (merchantJobCount() >= AI_QUEUE_MAX_MERCHANT_JOBS) return false;
    claimed.add(key);
    queue.push(job);
  } else {
    claimed.add(key);
    const firstMerchant = queue.findIndex((queued) => queued.kind === 'merchant');
    queue.splice(firstMerchant === -1 ? queue.length : firstMerchant, 0, job);
  }
  if (pump === null) pump = Promise.resolve().then(runQueue);
  return true;
}

/** Await the in-flight drain. Used by tests; nothing in the app waits on the model. */
export async function drainAiQueue(): Promise<void> {
  while (pump !== null) {
    await pump;
  }
}

export function resetAiQueueForTests(): void {
  queue.length = 0;
  claimed.clear();
  pump = null;
}

function dropEverything(): void {
  queue.length = 0;
  claimed.clear();
}

/**
 * The no-strand argument is the OCR queue's (its runQueue docblock): there is no await between the
 * shift that finds the queue empty and `pump = null`, and enqueueAiJob is synchronous, so a job
 * pushed while this loop runs is either shifted by it or starts a fresh pump.
 */
async function runQueue(): Promise<void> {
  for (;;) {
    const config = localAiActive(new Date()) ? readLocalAiConfig() : null;
    const job = config === null ? undefined : queue.shift();
    if (config === null || job === undefined) {
      if (config === null) dropEverything();
      pump = null;
      return;
    }
    try {
      await runJob(job, config);
    } catch (error) {
      if (error instanceof LocalAiServerError) {
        recordLocalAiFailure(new Date(), error.message);
        claimed.delete(jobKey(job));
        dropEverything();
        pump = null;
        return;
      }
      console.error('[ai] job failed', job.kind, error instanceof Error ? error.name : 'unknown');
    } finally {
      claimed.delete(jobKey(job));
    }
  }
}

function runJob(job: AiJob, config: LocalAiConfig): Promise<void> {
  return job.kind === 'merchant' ? runMerchantJob(job.merchant, config) : runReceiptJob(job.stagingId, job.userId, config);
}

/** An unreadable answer counts toward the streak; the fifth in a row is a server failure. */
function countUnreadable(): void {
  if (recordUnreadableAnswer() >= LOCAL_AI_UNREADABLE_LIMIT) throw new LocalAiServerError(LOCAL_AI_UNREADABLE_STREAK_ERROR);
}

async function runMerchantJob(merchant: string, config: LocalAiConfig): Promise<void> {
  // Filed, marked Always ask, or already answered since it was queued: no call.
  if (aiSuggestionFor(merchant) !== null) return;
  const row = merchantPromptRow(merchant);
  if (row === null) return;
  const { labels, idByLabel } = categoryChoices(listCategories({ includeArchived: true }));
  const answer = merchantAnswer(labels);
  try {
    const { content } = await chatJson({ config, prompt: merchantPrompt({ labels, row }), schemaName: 'merchant_suggestion', jsonSchema: answer.jsonSchema });
    const parsed = answer.zodSchema.safeParse(content);
    if (!parsed.success) throw new LocalAiAnswerError(LOCAL_AI_SHAPE_ERROR);
    const at = new Date();
    // The server answered in the shape asked for: it is working, whatever the answer says.
    recordLocalAiSuccess(at);
    const categoryId = parsed.data.category === null ? null : (idByLabel.get(parsed.data.category) ?? null);
    const cleanName = cleanMerchantName(parsed.data.merchant, row.rawDescription);
    if (categoryId === null && cleanName === null) {
      recordMerchantFailure({ merchant, model: config.model, reason: LOCAL_AI_NOTHING_USABLE_REASON, at });
      return;
    }
    recordMerchantSuggestion({ merchant, categoryId, cleanName, model: config.model, at });
  } catch (error) {
    if (!(error instanceof LocalAiAnswerError)) throw error;
    recordMerchantFailure({ merchant, model: config.model, reason: error.message, at: new Date() });
    countUnreadable();
  }
}

async function runReceiptJob(stagingId: string, userId: number, config: LocalAiConfig): Promise<void> {
  // The uploader's own receipt only, read by OCR, and not already answered.
  if (!stagedByViewer(stagingId, userId)) return;
  const ocr = readSidecar(stagingId);
  if (ocr === null || ocr.status !== 'done' || typeof ocr.text !== 'string' || ocr.text.trim().length === 0) return;
  if (readAiSidecar(stagingId) !== null) return;
  const today = todayIso(new Date());
  try {
    const { content } = await chatJson({ config, prompt: receiptPrompt({ text: ocr.text, today }), schemaName: 'receipt_fields', jsonSchema: RECEIPT_ANSWER.jsonSchema });
    const parsed = RECEIPT_ANSWER.zodSchema.safeParse(content);
    if (!parsed.success) throw new LocalAiAnswerError(LOCAL_AI_SHAPE_ERROR);
    const at = new Date();
    recordLocalAiSuccess(at);
    const fields = groundReceiptAnswer(parsed.data, ocr.text, today);
    writeAiSidecar(stagingId, Object.keys(fields).length > 0 ? { status: 'done', fields, at: at.toISOString() } : { status: 'failed', at: at.toISOString() });
  } catch (error) {
    // Whatever went wrong, the form stops waiting on this receipt.
    writeAiSidecar(stagingId, { status: 'failed', at: new Date().toISOString() });
    if (!(error instanceof LocalAiAnswerError)) throw error;
    countUnreadable();
  }
}

/**
 * The scheduler's five-minute sweep (and the Settings save): nothing unless the helper is active,
 * otherwise up to AI_SWEEP_LIMIT target merchants are queued. Returns how many were newly queued.
 */
export function sweepAiWork(now: Date = new Date()): number {
  if (!localAiActive(now)) return 0;
  let enqueued = 0;
  for (const merchant of aiMerchantTargets(AI_SWEEP_LIMIT)) {
    if (enqueueAiJob({ kind: 'merchant', merchant })) enqueued += 1;
  }
  return enqueued;
}
