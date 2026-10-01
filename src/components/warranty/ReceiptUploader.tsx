'use client';

import { type ChangeEvent, Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import { ReceiptScanPreview } from '@/components/warranty/ReceiptScanPreview';
import { scanReceiptFile, type ScanQuad } from '@/lib/scanner/scan';
import { SCANNER_AUTO_ACCEPT_MS } from '@/lib/warranty/ocr/onnx/constants';
import { candidateLabel, type AmountCandidate, type DateCandidate } from '@/lib/warranty/suggest';
import { isIsoDate } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import { buttonClass } from '@/components/ui/Button';
import { InUseIcon } from '@/components/ui/icons';

/**
 * The only file control in the feature: the camera input, whose exact shape MUST-6.1 fixes and
 * which only a coarse-pointer device (a phone or tablet) shows, and beside it a plain one without
 * capture (spec 2026-09-30 §2.5). MUST-10.2 fixes the behaviour:
 * OCR NEVER blocks the form. The Save button stays enabled the whole time.
 */
export interface StagedFile {
  stagingId: string;
  originalFilename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  /** URL.createObjectURL — the browser's own preview. No server-side image processing (§16.2). */
  previewUrl: string | null;
  ocr: 'pending' | 'done' | 'failed';
  error?: string;
  /** Spec 2026-09-30 §2.3: what the reader recognised, line by line, shown under the tile. */
  lines?: string[];
  /** Every amount and date found, with the words around it, offered as chips. */
  candidates?: { amounts: AmountCandidate[]; dates: DateCandidate[] };
  /** What the read found. */
  suggestions?: SuggestedFieldsDto;
  /** What the page actually filled from it, for the tile's one-line summary. */
  filled?: ReadonlyArray<FilledField>;
}

/** A form field a read can fill, as the tile's summary names it. */
export type FilledField = 'vendor' | 'date' | 'amount';
const FILLED_ORDER: readonly FilledField[] = ['vendor', 'date', 'amount'];
/** The read field a page's date chips fill: a bill's due date, otherwise the start date. */
export type DateField = 'purchaseDate' | 'dueDate';
/** What the fields a page's chips fill hold now: the amount in cents and the date as ISO. */
export interface FiguresInUse {
  amountCents?: number;
  date?: string;
}

export interface SuggestedFieldsDto {
  purchaseDate?: string;
  vendor?: string;
  priceCents?: number;
  /** Spec 2026-09-30 §2.3: a bill's due date. Optional until the extractor reads one. */
  dueDate?: string;
}

/** Spec 2026-09-30 §2.3: a read that found nothing says so, rather than a bare "Read". */
export const SCAN_SUMMARY_NOTHING = 'Read, but found no vendor, date or amount — check the text below.';

/**
 * The tile's one line on a finished read. It names only what the page filled, not everything the
 * read found: a detail page fills nothing, a bill's fills no vendor, and a typed field is kept. A
 * read that found something the page did not take gets no line; the read text and chips still show.
 */
export function summaryOf(fields: SuggestedFieldsDto, filled: ReadonlyArray<FilledField>): string | null {
  const found = Boolean(fields.vendor || fields.purchaseDate || fields.dueDate || fields.priceCents !== undefined);
  if (!found) return SCAN_SUMMARY_NOTHING;
  const named = FILLED_ORDER.filter((field) => filled.includes(field));
  if (named.length === 0) return null;
  return `Filled ${named.join(', ')}${fields.priceCents === undefined ? ' — no total found' : ''}.`;
}

/**
 * A chip's date, readable, with or without its year. Read at local midnight: `new Date(iso)` alone
 * parses as UTC and shows the day before anywhere west of it (the same fix transactions-client.tsx
 * applies).
 */
function chipDate(iso: string, withYear = true): string {
  if (!isIsoDate(iso)) return iso;
  return new Date(`${iso}T00:00:00`).toLocaleDateString(
    'en-US',
    withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' },
  );
}

export const POLL_INTERVAL_MS = 1500;
export const POLL_GIVE_UP_MS = 180_000;
export const POLL_GIVE_UP_MESSAGE = 'Still processing — save now and re-run OCR from the item page.';
export const READING_MESSAGE =
  "Reading receipt… you can fill this in and save now; suggestions will appear when it's done.";
/**
 * F5 follow-up (v1.8.0 spec, Task 7 Step 5). Shown for the whole `scanning` window, not just
 * the loadScanner() portion of it: this component only ever sees scanReceiptFile() as one
 * opaque call (loadScanner() is an internal step of it, in src/lib/scanner/scan.ts), so there
 * is no signal in here to distinguish "downloading the ~9 MB runtime" from "already warm,
 * just finding the paper in this photo." On a cold first use loadScanner() dominates that
 * window (a network fetch vs. milliseconds of contour-finding on an already-capped image), so
 * the copy is accurate for the case it matters most for; on a warm pick the whole window is
 * short enough that the exact wording on screen for that instant is not worth a second state.
 */
export const SCANNER_PREPARING_MESSAGE = 'Preparing the scanner — first use downloads about 9 MB.';
/**
 * MUST-8.15's fallback (an upload is never blocked by the scanner) already ran before this
 * text existed -- scanReceiptFile() swallows every failure and hands back the original file
 * with no visible error. This is purely the "surface it" half: say why, once, rather than
 * leaving the pick silently skip straight to a plain upload. It fires from decide()'s own
 * catch, which today is a belt-and-braces path (scanReceiptFile is documented never to
 * reject) rather than one a real scan failure reaches -- see that catch's own comment.
 */
export const SCANNER_UNAVAILABLE_MESSAGE = 'Scanning is unavailable, uploading the original photo instead.';
/**
 * Spec 2026-09-30 §2.5: a scan that found no usable paper edges says so instead of uploading in
 * silence. Its own line, not the shared notice: upload() puts READING_MESSAGE there a moment
 * later, which would make this a flash nobody can read. Shown for no-paper and bad-quad only; a
 * too-large crop found the edges fine and fell back on the byte cap.
 */
export const SCANNER_NO_PAPER_MESSAGE = "Couldn't find the paper edges — using the whole photo.";

interface StageResponse {
  staged?: { stagingId: string; originalFilename: string; mime: string; sizeBytes: number; sha256: string }[];
  error?: string;
}

interface PollResponse {
  status: 'pending' | 'done' | 'failed';
  suggestions?: SuggestedFieldsDto;
  lines?: string[];
  candidates?: { amounts: AmountCandidate[]; dates: DateCandidate[] };
  error?: string;
}

const READ_FAILED_MESSAGE = 'That receipt could not be read.';

interface Pending {
  original: File;
  corrected: File;
  originalUrl: string;
  correctedUrl: string;
  quad: ScanQuad;
  sourceWidth: number;
  sourceHeight: number;
}

const COUNTDOWN_TICK_MS = 1000;

/**
 * A file input prints its own "No file chosen" text beside its button, so each input is visually
 * hidden inside its label and the label is the button (FileDrop.tsx does the same). `relative`
 * holds the `sr-only` input. A label is never :focus-visible or :disabled itself, so it takes both
 * from its input. 44px floor on a phone via `min-h-11 sm:min-h-0`, as QuickAddTransaction.tsx does.
 */
const PICK_BUTTON_CLASS = buttonClass(
  'secondary',
  'sm',
  'relative min-h-11 sm:min-h-0 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus has-[:disabled]:pointer-events-none has-[:disabled]:opacity-55',
);

/**
 * reconcile-loan-form.tsx's chip, so a figure to tap looks the same on every surface, holding only
 * its value. The one in use takes the accent. 44px floor on a phone, as PICK_BUTTON_CLASS has.
 */
const CHIP_CLASS =
  'inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-md border border-line px-2 py-1 text-xs text-muted tabnum hover:border-accent sm:min-h-0 aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-soft-fg';

/** One candidate per value, the better-scored one, in the order the read ranked them. */
function onePerValue<T extends { score: number }>(candidates: readonly T[], valueOf: (candidate: T) => string | number): T[] {
  const kept = new Map<string | number, T>();
  for (const candidate of candidates) {
    const prior = kept.get(valueOf(candidate));
    if (prior === undefined || candidate.score > prior.score) kept.set(valueOf(candidate), candidate);
  }
  return [...kept.values()];
}

/**
 * A figure to tap, showing only its value. Its name starts with what it shows (label in name,
 * WCAG 2.5.3), then the rest of the value and the receipt's words, which a hover gets as the title.
 * A label, not a visually hidden span: a hidden span is out of flow, and the name then reads with
 * a stray space before its comma. The words are text from an arbitrary receipt: attributes only,
 * never markup (MUST-13.3).
 */
function FigureChip({
  shown,
  full,
  snippet,
  pressed,
  onPick,
}: {
  shown: string;
  full: string;
  snippet: string;
  pressed: boolean;
  onPick: () => void;
}) {
  const name = `${shown}${full.startsWith(shown) ? full.slice(shown.length) : ''}${snippet ? `, ${snippet}` : ''}`;
  return (
    <button type="button" aria-pressed={pressed} aria-label={name} title={name} onClick={onPick} className={CHIP_CLASS}>
      {pressed ? <InUseIcon aria-hidden="true" strokeWidth={2.5} className="size-3 shrink-0" /> : null}
      {shown}
    </button>
  );
}

/**
 * A done tile's figures (spec 2026-09-30 §2.3): the amount and the date in use first, one row each,
 * and every candidate under a folded "Other figures". In use is the figure the field holds NOW, so
 * a tap, a later read, a typed value, a kind change or an emptied form all show as they land. No
 * pick handler, no row and no chips for that field.
 */
function ReadFigures({
  candidates,
  inUse,
  dateField,
  onPickAmount,
  onPickDate,
}: {
  candidates: { amounts: AmountCandidate[]; dates: DateCandidate[] };
  inUse?: FiguresInUse;
  dateField: DateField;
  onPickAmount?: (cents: number) => void;
  onPickDate?: (iso: string) => void;
}) {
  const id = useId();
  const amounts = onPickAmount ? onePerValue(candidates.amounts, (candidate) => candidate.valueCents) : [];
  const dates = onPickDate ? onePerValue(candidates.dates, (candidate) => candidate.date) : [];
  const amountInUse = amounts.find((candidate) => candidate.valueCents === inUse?.amountCents);
  const dateInUse = dates.find((candidate) => candidate.date === inUse?.date);
  const others = amounts.length + dates.length - (amountInUse ? 1 : 0) - (dateInUse ? 1 : 0);
  // The year goes only when every date here shares one; the name and the title keep it.
  const oneYear = new Set(dates.map((candidate) => candidate.date.slice(0, 4))).size === 1;

  const rows = [
    amountInUse ? { field: 'Amount', value: formatCents(amountInUse.valueCents), candidate: amountInUse } : null,
    dateInUse ? { field: dateField === 'dueDate' ? 'Due' : 'Date', value: chipDate(dateInUse.date), candidate: dateInUse } : null,
  ].filter((row) => row !== null);

  return (
    <>
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5">
          {rows.map((row) => {
            const words = candidateLabel(row.candidate);
            return (
              <Fragment key={row.field}>
                <dt className="text-subtle">{row.field}</dt>
                <dd className="flex min-w-0 gap-1.5">
                  <span className="shrink-0 font-medium text-ink tabnum">{row.value}</span>
                  {words ? (
                    <span className="min-w-0 truncate text-muted" title={row.candidate.snippet}>
                      {words}
                    </span>
                  ) : null}
                </dd>
              </Fragment>
            );
          })}
        </dl>
      ) : null}
      {others > 0 ? (
        <details>
          <summary className="cursor-pointer text-subtle">Other figures ({others})</summary>
          <div className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1.5">
            {amounts.length > 0 ? (
              <>
                <span id={`${id}-amounts`} className="text-subtle">
                  Amounts
                </span>
                <div role="group" aria-labelledby={`${id}-amounts`} className="flex flex-wrap gap-1">
                  {amounts.map((candidate) => (
                    <FigureChip
                      key={candidate.valueCents}
                      shown={formatCents(candidate.valueCents)}
                      full={formatCents(candidate.valueCents)}
                      snippet={candidate.snippet}
                      pressed={candidate === amountInUse}
                      onPick={() => onPickAmount?.(candidate.valueCents)}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {dates.length > 0 ? (
              <>
                <span id={`${id}-dates`} className="text-subtle">
                  Dates
                </span>
                <div role="group" aria-labelledby={`${id}-dates`} className="flex flex-wrap gap-1">
                  {dates.map((candidate) => (
                    <FigureChip
                      key={candidate.date}
                      shown={chipDate(candidate.date, !oneYear)}
                      full={chipDate(candidate.date)}
                      snippet={candidate.snippet}
                      pressed={candidate === dateInUse}
                      onPick={() => onPickDate?.(candidate.date)}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </details>
      ) : null}
    </>
  );
}

export function ReceiptUploader({
  onStagedChange,
  onSuggestions,
  onPickAmount,
  onPickDate,
  dateField = 'purchaseDate',
  inUse,
  label = 'Receipt photo or PDF',
}: {
  onStagedChange: (files: StagedFile[]) => void;
  /** Fills the page from a read, and returns the fields it actually filled. Nothing returned is nothing filled. */
  onSuggestions?: (suggestions: SuggestedFieldsDto) => ReadonlyArray<FilledField> | void;
  /** A tapped amount chip (spec §2.3). No handler, no amount chips: a chip that does nothing is worse than none. */
  onPickAmount?: (cents: number) => void;
  /** A tapped date chip, as an ISO date. No handler, no date chips. */
  onPickDate?: (iso: string) => void;
  /**
   * The read field the date chips fill: a bill's due date, otherwise the start date. Names the date
   * row in use ("Due" or "Date") and says which filled date it is.
   */
  dateField?: DateField;
  /**
   * What the fields the chips fill hold now. A chip of that value is the one in use, and its row
   * leads the tile; a figure no chip has, or an empty field, shows no row.
   */
  inUse?: FiguresInUse;
  label?: string;
}) {
  const captionId = useId();
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  // IMPORTANT 4: mirrors `files` so the unmount-cleanup effect below (which must run only
  // once, with empty deps, to avoid re-registering on every render) can still revoke
  // whatever object URLs exist AT UNMOUNT TIME rather than the ones captured in its stale
  // closure over the first render's (empty) `files` array.
  const filesRef = useRef<StagedFile[]>([]);
  // IMPORTANT 4's stale-closure reason applies here too: the unmount effect runs once with
  // empty deps, so it needs a ref to see whatever preview URLs exist AT UNMOUNT TIME.
  const previewUrlsRef = useRef<string[]>([]);
  const resolvePendingRef = useRef<((file: File) => void) | null>(null);
  // The file each staging id was uploaded from, so Try again can send the same one again.
  const originalsRef = useRef(new Map<string, File>());
  // Review focus 5: every staging id still being polled. The shared notice belongs to all of
  // them, so the first receipt to finish no longer clears it for the rest.
  const readingRef = useRef(new Set<string>());

  useEffect(() => {
    filesRef.current = files;
    onStagedChange(files);
  }, [files, onStagedChange]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearInterval(timer);
      for (const file of filesRef.current) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      resolvePendingRef.current = null;
    },
    // Cleanup on unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (pending === null) return;
    setSecondsLeft(Math.ceil(SCANNER_AUTO_ACCEPT_MS / COUNTDOWN_TICK_MS));
    const tick = setInterval(() => setSecondsLeft((left) => Math.max(0, left - 1)), COUNTDOWN_TICK_MS);
    const accept = setTimeout(() => resolvePendingRef.current?.(pending.corrected), SCANNER_AUTO_ACCEPT_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(accept);
    };
  }, [pending]);

  const poll = useCallback(
    (stagingId: string) => {
      const startedAt = Date.now();
      readingRef.current.add(stagingId);
      /** This receipt stopped reading. The reading notice goes only once none is left. */
      const settle = () => {
        readingRef.current.delete(stagingId);
        if (readingRef.current.size === 0) setNotice((current) => (current === READING_MESSAGE ? null : current));
      };
      /*
        MUST-10.2 step 4: show the error and carry on. On the tile it belongs to rather than the
        shared notice, which several receipts share and which stays on while any still reads.
        Rendered as a text node only (MUST-13.3) — never dangerouslySetInnerHTML.
      */
      const fail = (error: string) => {
        setFiles((prev) => prev.map((file) => (file.stagingId === stagingId ? { ...file, ocr: 'failed', error } : file)));
        settle();
      };
      const timer = setInterval(async () => {
        // IMPORTANT 2: a rejected fetch/json (offline, transient network blip) must not
        // become an unhandled promise rejection, and must not kill this interval either --
        // just skip this tick and retry at the next one. POLL_GIVE_UP_MS above still bounds
        // how long that can go on.
        try {
          if (Date.now() - startedAt > POLL_GIVE_UP_MS) {
            clearInterval(timer);
            readingRef.current.delete(stagingId);
            setNotice(POLL_GIVE_UP_MESSAGE);
            return;
          }
          const response = await fetch(`/api/warranties/receipts/stage/${stagingId}`);
          if (!response.ok) {
            // IMPORTANT 3: a non-ok response (e.g. a 401 on session expiry) must not leave
            // this tile reading "Reading…" forever -- mark it failed and stop polling it.
            clearInterval(timer);
            fail(READ_FAILED_MESSAGE);
            return;
          }
          const body = (await response.json()) as PollResponse;
          if (body.status === 'pending') return;
          clearInterval(timer);
          if (body.status === 'failed') {
            fail(body.error ?? READ_FAILED_MESSAGE);
            return;
          }
          const filled = (onSuggestions && body.suggestions ? onSuggestions(body.suggestions) : undefined) ?? [];
          setFiles((prev) =>
            prev.map((file) =>
              file.stagingId === stagingId
                ? {
                    ...file,
                    ocr: 'done',
                    error: undefined,
                    lines: body.lines ?? [],
                    candidates: body.candidates ?? { amounts: [], dates: [] },
                    suggestions: body.suggestions ?? {},
                    filled,
                  }
                : file,
            ),
          );
          settle();
        } catch {
          // Transient failure this tick only -- leave the timer running.
        }
      }, POLL_INTERVAL_MS);
      timers.current.push(timer);
    },
    [onSuggestions],
  );

  async function upload(chosen: File[]): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      for (const file of chosen) form.append('file', file);
      const response = await fetch('/api/warranties/receipts/stage', { method: 'POST', body: form });
      const body = (await response.json()) as StageResponse;
      if (!response.ok || !body.staged) {
        setError(body.error ?? 'That upload did not work.');
        return;
      }
      // CRITICAL fix: `chosen` is a plain array snapshot taken BEFORE the input's value was
      // reset, unlike the live FileList the input exposes -- browsers clear (not swap) that
      // FileList in place, so by the time this line ran against the original FileList
      // reference, `list[index]` would already be undefined and URL.createObjectURL() would
      // throw, silently dropping every image receipt (PDFs were unaffected only because
      // their branch never calls createObjectURL).
      const staged: StagedFile[] = body.staged.map((entry, index) => ({
        ...entry,
        previewUrl: entry.mime.startsWith('image/') ? URL.createObjectURL(chosen[index]) : null,
        ocr: 'pending' as const,
      }));
      body.staged.forEach((entry, index) => originalsRef.current.set(entry.stagingId, chosen[index]));
      setFiles((prev) => [...prev, ...staged]);
      setNotice(READING_MESSAGE);
      for (const entry of staged) poll(entry.stagingId);
    } finally {
      setBusy(false);
    }
  }

  function releasePreview(entry: Pending): void {
    for (const url of [entry.originalUrl, entry.correctedUrl]) {
      URL.revokeObjectURL(url);
      previewUrlsRef.current = previewUrlsRef.current.filter((value) => value !== url);
    }
  }

  async function decide(original: File): Promise<File> {
    if (!original.type.startsWith('image/')) return original;
    setScanning(true);
    let result;
    try {
      result = await scanReceiptFile(original);
    } catch {
      // scanReceiptFile is documented never to reject, and this is the belt for that brace:
      // an upload is never blocked by the scanner. MUST-8.15 already guaranteed the fallback;
      // this notice is the F5 follow-up (v1.8.0) that surfaces WHY one is happening instead
      // of silently handing the pick straight to upload().
      setNotice(SCANNER_UNAVAILABLE_MESSAGE);
      return original;
    } finally {
      setScanning(false);
    }
    if (result.corrected === undefined) {
      if (result.reason === 'no-paper' || result.reason === 'bad-quad') setScanNote(SCANNER_NO_PAPER_MESSAGE);
      return result.file;
    }

    const originalUrl = URL.createObjectURL(original);
    previewUrlsRef.current = [...previewUrlsRef.current, originalUrl, result.corrected.url];
    const entry: Pending = {
      original,
      corrected: result.file,
      originalUrl,
      correctedUrl: result.corrected.url,
      quad: result.corrected.quad,
      sourceWidth: result.corrected.sourceWidth,
      sourceHeight: result.corrected.sourceHeight,
    };
    const chosen = await new Promise<File>((resolve) => {
      resolvePendingRef.current = resolve;
      setPending(entry);
    });
    resolvePendingRef.current = null;
    setPending(null);
    releasePreview(entry);
    return chosen;
  }

  async function handlePicked(chosen: File[]): Promise<void> {
    // A new pick gets its own word on the scan, not the last one's.
    setScanNote(null);
    // Sequentially, never in parallel: three simultaneous warps is how a mid-range Android
    // tab crashes.
    for (const original of chosen) {
      const file = await decide(original);
      await upload([file]);
    }
  }

  /** Both inputs, the camera one and the plain one, hand their pick over the same way. */
  function onPick(event: ChangeEvent<HTMLInputElement>): void {
    // CRITICAL fix: snapshot the FileList into a plain array FIRST. Resetting
    // event.target.value below clears the browser's underlying FileList object (it
    // does not swap in a new, separate one) -- any reference to `list` taken after
    // that point sees an empty list once the async upload() resumes past its first
    // await, which is exactly what silently dropped every image receipt before.
    const list = event.target.files;
    const chosen = list ? Array.from(list) : [];
    if (chosen.length > 0) void handlePicked(chosen);
    event.target.value = '';
  }

  function remove(stagingId: string): void {
    originalsRef.current.delete(stagingId);
    setFiles((prev) => {
      const target = prev.find((file) => file.stagingId === stagingId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((file) => file.stagingId !== stagingId);
    });
  }

  /** A failed read, sent again: the same file, staged afresh, instead of the failed tile. */
  function retry(stagingId: string): void {
    const file = originalsRef.current.get(stagingId);
    remove(stagingId);
    if (file) void upload([file]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-labelledby={captionId} className="flex flex-col gap-1.5">
        <span id={captionId} className="field-label">
          {label}
        </span>
        <div className="flex flex-wrap gap-2">
          {/* MUST-6.1, exactly: capture="environment" opens a phone's rear camera directly and
              is ignored by a desktop browser. There is no native app and no live camera stream
              requested from the page -- the still image the camera app hands back is then
              straightened with an in-browser canvas crop, never a live viewfinder.
              A desktop would show it as a second "Choose a file", so only a coarse pointer
              shows it. CSS alone, so the server and the browser render the same markup. */}
          <label className={`${PICK_BUTTON_CLASS} hidden pointer-coarse:inline-flex`}>
            <input
              type="file"
              name="file"
              accept="image/*,application/pdf"
              capture="environment"
              multiple
              disabled={busy}
              onChange={onPick}
              className="sr-only"
            />
            Take a photo
          </label>
          {/* Spec 2026-09-30 §2.5: with capture set, a phone goes straight to the camera and offers
              no way to a PDF or a photo already taken. This one has no capture, so it opens the
              phone's file picker; on a desktop it is the only button. */}
          <label className={PICK_BUTTON_CLASS}>
            <input
              type="file"
              accept="image/*,application/pdf"
              multiple
              disabled={busy}
              onChange={onPick}
              className="sr-only"
            />
            Choose a file
          </label>
        </div>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}
      {scanNote ? <p className="text-sm text-muted">{scanNote}</p> : null}

      {scanning ? (
        <p className="text-sm text-muted" role="status">
          {SCANNER_PREPARING_MESSAGE}
        </p>
      ) : null}
      {pending !== null ? (
        <ReceiptScanPreview
          originalUrl={pending.originalUrl}
          correctedUrl={pending.correctedUrl}
          quad={pending.quad}
          sourceWidth={pending.sourceWidth}
          sourceHeight={pending.sourceHeight}
          secondsLeft={secondsLeft}
          onUseThis={() => resolvePendingRef.current?.(pending.corrected)}
          onUseOriginal={() => resolvePendingRef.current?.(pending.original)}
        />
      ) : null}

      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-3">
          {files.map((file) => {
            const summary = file.ocr === 'done' ? summaryOf(file.suggestions ?? {}, file.filled ?? []) : null;
            return (
              <li
                key={file.stagingId}
                className="flex w-full flex-col gap-1.5 rounded-md border border-line bg-surface-2/50 p-2 text-xs sm:w-72"
              >
                <span className="flex h-24 items-center justify-center overflow-hidden rounded-xs bg-surface">
                  {file.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={file.previewUrl} alt={file.originalFilename} className="max-h-24 w-full object-contain" />
                  ) : (
                    <span className="text-subtle">PDF</span>
                  )}
                </span>
                <span className="truncate font-medium text-ink" title={file.originalFilename}>{file.originalFilename}</span>
                <span className={file.ocr === 'failed' ? 'money-neg' : 'text-subtle'}>
                  {file.ocr === 'pending' ? 'Reading…' : file.ocr === 'done' ? 'Read' : 'Could not read'}
                </span>
                {file.ocr === 'failed' && file.error ? <p className="text-muted">{file.error}</p> : null}
                {summary !== null ? <p className="text-muted">{summary}</p> : null}
                {file.ocr === 'done' ? (
                  <ReadFigures
                    candidates={file.candidates ?? { amounts: [], dates: [] }}
                    inUse={inUse}
                    dateField={dateField}
                    onPickAmount={onPickAmount}
                    onPickDate={onPickDate}
                  />
                ) : null}
                {/* Spec 2026-09-30 §2.3: what the reader saw, so a wrong or missing figure can be
                    checked against it. Text from an arbitrary receipt: text nodes only (MUST-13.3). */}
                {file.lines && file.lines.length > 0 ? (
                  <details>
                    <summary className="cursor-pointer text-subtle">What was read</summary>
                    <ol className="mt-1 flex max-h-48 flex-col gap-0.5 overflow-y-auto break-words text-muted">
                      {file.lines.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ol>
                  </details>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  {file.ocr === 'failed' ? (
                    <button
                      type="button"
                      onClick={() => retry(file.stagingId)}
                      disabled={busy}
                      className={buttonClass('ghost', 'sm', 'w-fit px-1.5 text-xs')}
                    >
                      Try again
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => remove(file.stagingId)}
                    aria-label={`Remove ${file.originalFilename}`}
                    className={buttonClass('ghost', 'sm', 'w-fit px-1.5 text-xs')}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
