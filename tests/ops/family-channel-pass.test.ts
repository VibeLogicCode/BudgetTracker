import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { householdEligibleEvents } from '@/lib/notify/events';

const ROOT = process.cwd();
const HOUSEHOLD_BLOCK = 'src/lib/notify/evaluate/index.ts';
const RULING = 'src/lib/notify/family-pass.ts';

/** Same walk() and stripComments() as tests/ops/spend-where.test.ts. */
function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function read(file: string): string {
  return stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

/**
 * v1.32.0, RULING R23. A family-channel row used to be written only as a side effect of some
 * member's evaluation, so an event nobody had switched on personally produced no family row at all.
 * src/lib/notify/family-pass.ts carries the ruling; this guard carries the thing a ruling cannot,
 * which is that it still holds for EVERY household-eligible event after the next one is added.
 *
 * The list below is driven from the REGISTRY, not written out beside it: the `it` blocks walk
 * `householdEligibleEvents()` and require an entry for each, so appending a fourteenth eligible
 * event to NOTIFICATION_EVENTS fails this file until somebody says which evaluator carries its
 * household pass -- or writes down, checkably, that it needs none.
 *
 * WHAT IS CHECKED, per entry:
 *   - 'household-pass': the named evaluator consults `familyChannelNeedsOwnPass('<id>')` (the one
 *     definition of "is the family channel the only subscriber"), and its enqueue path can carry a
 *     null recipient at all (`userId: number | null` somewhere in the file). Where the event fires
 *     on a slot rather than a tick, the household's own block in evaluate/index.ts must actually
 *     call the named entry point with `userId: null` -- otherwise the pass exists and nothing ever
 *     runs it, which is the failure this whole ruling is about wearing a different hat.
 *   - 'no-personal-gate': the named evaluator contains NO `isEventEnabled` at all. That is the
 *     entire reason those two events never had the defect -- they run for every notifiable user
 *     whatever that user's toggles say -- and the day somebody adds a gate to one of them, this
 *     fails and asks for a household pass instead of quietly reintroducing R23 for that event.
 *
 * WHAT IS NOT CHECKED HERE: that a household pass actually produces a row. Source text cannot show
 * that, and asserting it from source is how a guard ends up believing something false.
 * tests/lib/notify/evaluate/family-channel-pass.test.ts runs each evaluator against a household
 * with a family channel and no personal subscribers and reads the outbox.
 */
interface HouseholdPassOwner {
  kind: 'household-pass' | 'no-personal-gate';
  /** The evaluator that owns this event. */
  file: string;
  /** The exported function evaluate/index.ts's household block calls, for slot-fired events. */
  entryPoint: string | null;
  /**
   * 2026-09-09. WHERE that entry point is called with a null recipient, when it is not the
   * household block in evaluate/index.ts.
   *
   * The three month-boundary events moved out of the daily slot: their trigger is the month being
   * CLOSED, and the loop over every recipient has to be owned in ONE place so the month can be
   * marked summarised once everybody has been evaluated (flushMonthSummaries -- see its docblock
   * for the defect that made that necessary). The family channel's null pass moved with them.
   *
   * A field rather than a loosened assertion: the claim this test makes is "something actually
   * runs the household pass", and naming the caller keeps that claim exact instead of widening it
   * to "somewhere in the repo".
   */
  entryPointIn?: { file: string; fn: string };
  why: string;
}

const HOUSEHOLD_PASS_OWNERS: Record<string, HouseholdPassOwner> = {
  coming_due: {
    kind: 'no-personal-gate',
    file: 'src/lib/notify/evaluate/coming-due.ts',
    entryPoint: null,
    why: 'evaluateComingDue reads no preference at all: it runs at every notifiable user\'s daily slot over that user\'s own items, so the family row was written whatever anybody had switched on.',
  },
  weekly_digest: {
    kind: 'no-personal-gate',
    file: 'src/lib/notify/evaluate/digest.ts',
    entryPoint: null,
    why: 'evaluateWeeklyDigest reads no preference either -- index.ts calls it on every user\'s weekly slot, gated only on whether a digest for that slot already exists -- and it already builds the room\'s own message through buildHouseholdDigest.',
  },
  budget_threshold: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/budget.ts',
    entryPoint: null,
    why: 'a tick event: evaluateBudgets owns its own participant roster and runs once per tick from runScheduledEvaluation, so the family channel joins that roster rather than being called separately, at HOUSEHOLD_PASS_SETTINGS.budgetThresholdPct rather than any member\'s.',
  },
  budget_exceeded: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/budget.ts',
    entryPoint: null,
    why: 'the second half of the same tick pass, fired from the same fireFor over the same household rows.',
  },
  budget_pace: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/pace.ts',
    entryPoint: null,
    why: '2026-09-09: no longer scheduled at all. The projection is a section of the weekly summary (evaluate/digest.ts, collectBudgets), so the room reads it in the household digest buildHouseholdDigest already renders -- the same place budget_threshold and budget_exceeded went. evaluateBudgetPace still exists and still takes a null recipient; nothing calls it.',
  },
  unusual_transaction: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/anomalies.ts',
    entryPoint: null,
    why: 'a tick event: the family channel is pushed onto evaluateAnomalies\' own participant list, which v1.31.0\'s admin-only narrowing made likely to be empty in an ordinary household.',
  },
  duplicate_charge: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/anomalies.ts',
    entryPoint: null,
    why: 'the other half of the same participant list, from the same slice of transactions.',
  },
  subscription_creep: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/anomalies.ts',
    entryPoint: 'evaluateSubscriptionCreep',
    why: 'a daily-slot event, unlike the two above: evaluateSubscriptionCreep is called once per recipient, so the household block calls it with userId null. Its figures are already household-wide.',
  },
  predicted_vs_actual: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/monthly.ts',
    entryPoint: 'evaluateMonthBoundary',
    entryPointIn: { file: 'src/lib/notify/evaluate/monthly.ts', fn: 'export function flushMonthSummaries(' },
    why: 'inside evaluateMonthBoundary, run from flushMonthSummaries since 2026-09-09 rather than from the daily slot; with userId null the recipient is HOUSEHOLD_VIEWER, so `own` is the household comparison finding I-1 already built for the room.',
  },
  suggested_budget_refresh: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/monthly.ts',
    entryPoint: 'evaluateMonthBoundary',
    entryPointIn: { file: 'src/lib/notify/evaluate/monthly.ts', fn: 'export function flushMonthSummaries(' },
    why: 'the second of evaluateMonthBoundary\'s three, on the same household read and the same null recipient.',
  },
  monthly_digest: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/monthly.ts',
    entryPoint: 'evaluateMonthBoundary',
    entryPointIn: { file: 'src/lib/notify/evaluate/monthly.ts', fn: 'export function flushMonthSummaries(' },
    why: 'the third: renderMonthlyDigestFor takes a viewer, so the household pass is that same call through HOUSEHOLD_VIEWER and there is no second definition of the room\'s digest.',
  },
  savings_target_met: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/savings.ts',
    entryPoint: null,
    why: 'a tick event (ruling T3, household-wide): evaluateSavingsTargetMet enqueues the one shared render to the family channel after its participant loop.',
  },
  savings_target_pace: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/savings.ts',
    entryPoint: 'evaluateSavingsDaily',
    why: 'a daily-slot event: the household block calls evaluateSavingsDaily with userId null, and the figures are already read through HOUSEHOLD_VIEWER for every recipient.',
  },
  savings_month_closed: {
    kind: 'household-pass',
    file: 'src/lib/notify/evaluate/savings.ts',
    entryPoint: 'evaluateSavingsDaily',
    why: 'the other half of evaluateSavingsDaily, on the same null recipient and the same pooled figures.',
  },
};

/** The source of `file` from the declaration of `fn` onwards. */
function blockOf(file: string, fn: string): string {
  const source = read(file);
  const at = source.indexOf(fn);
  expect(at, `${file} no longer declares ${fn}`).toBeGreaterThan(-1);
  return source.slice(at);
}

/** The body of runHouseholdEvaluation, the default home of a slot-fired household pass. */
function householdBlock(): string {
  const source = read(HOUSEHOLD_BLOCK);
  const at = source.indexOf('function runHouseholdEvaluation(');
  expect(at, `${HOUSEHOLD_BLOCK} no longer declares runHouseholdEvaluation()`).toBeGreaterThan(-1);
  return source.slice(at);
}

describe('R23: every household-eligible event has a family-channel pass, or a checkable reason it needs none', () => {
  const eligible = householdEligibleEvents().map((event) => event.id);

  it('reads a registry with events in it (positive control)', () => {
    // A scan over an empty registry would pass every assertion below without looking at anything.
    expect(eligible.length).toBeGreaterThanOrEqual(14);
    expect(read(RULING)).toContain('export function familyChannelNeedsOwnPass');
    expect(householdBlock()).toContain('userId: null');
  });

  it('names an owner for every household-eligible event, and nothing that is not one', () => {
    const listed = Object.keys(HOUSEHOLD_PASS_OWNERS).sort();
    const unlisted = eligible.filter((id) => !(id in HOUSEHOLD_PASS_OWNERS)).sort();
    const stale = listed.filter((id) => !eligible.includes(id));
    expect(
      unlisted,
      'a new household-eligible event has no family-channel pass. Say which evaluator carries it, or -- if that evaluator has no personal gate at all -- record it as no-personal-gate with the sentence that says so',
    ).toEqual([]);
    expect(stale, 'HOUSEHOLD_PASS_OWNERS names an event that is no longer household-eligible').toEqual([]);
  });

  it('every household-pass owner consults the one definition and can carry a null recipient', () => {
    const broken: string[] = [];
    for (const [eventId, owner] of Object.entries(HOUSEHOLD_PASS_OWNERS)) {
      if (owner.kind !== 'household-pass') continue;
      const source = read(owner.file);
      if (!source.includes(`familyChannelNeedsOwnPass('${eventId}')`)) {
        broken.push(`${eventId}: ${owner.file} does not call familyChannelNeedsOwnPass('${eventId}')`);
      }
      if (!/userId:\s*number\s*\|\s*null/.test(source)) {
        broken.push(`${eventId}: ${owner.file} has no function that accepts a null recipient`);
      }
    }
    expect(
      broken,
      "a household pass no longer consults familyChannelNeedsOwnPass, which is what keeps it mutually exclusive with the member path -- without it the family channel can be sent the same event twice",
    ).toEqual([]);
  });

  it('every slot-fired household pass is actually reached from the block that owns it', () => {
    const unreachable = Object.entries(HOUSEHOLD_PASS_OWNERS)
      .filter(([, owner]) => owner.entryPoint !== null)
      .filter(([, owner]) => {
        const block =
          owner.entryPointIn === undefined ? householdBlock() : blockOf(owner.entryPointIn.file, owner.entryPointIn.fn);
        return !block.includes(`${owner.entryPoint}({ userId: null`);
      })
      .map(
        ([eventId, owner]) =>
          `${eventId}: ${owner.entryPointIn?.fn ?? 'runHouseholdEvaluation'} never calls ${owner.entryPoint}({ userId: null, ... })`,
      );
    expect(
      unreachable,
      'a household pass exists and nothing runs it, which leaves the family channel exactly as silent as it was before R23',
    ).toEqual([]);
  });

  it('every no-personal-gate owner really has no personal gate', () => {
    const gated: string[] = [];
    for (const [eventId, owner] of Object.entries(HOUSEHOLD_PASS_OWNERS)) {
      if (owner.kind !== 'no-personal-gate') continue;
      const source = read(owner.file);
      if (source.includes('isEventEnabled')) {
        gated.push(`${eventId}: ${owner.file} now consults isEventEnabled, so its family row can go missing again`);
      }
      if (source.includes('familyChannelNeedsOwnPass')) {
        gated.push(`${eventId}: ${owner.file} has a household pass after all -- record it as kind 'household-pass'`);
      }
    }
    expect(
      gated,
      "an evaluator recorded as having no personal gate has grown one. Either drop the gate or give the event a household pass: with a gate and no pass, a household that has routed the event and switched it off personally gets nothing (R23)",
    ).toEqual([]);
  });

  it('no household pass exists for an event nobody wrote down', () => {
    const declared = new Set<string>();
    for (const file of walk('src')) {
      for (const match of read(file).matchAll(/familyChannelNeedsOwnPass\(\s*'([a-z_]+)'\s*\)/g)) {
        declared.add(`${match[1]} @ ${file}`);
      }
    }
    const orphans = [...declared]
      .filter((entry) => {
        const [eventId, file] = entry.split(' @ ');
        const owner = HOUSEHOLD_PASS_OWNERS[eventId];
        return owner === undefined || owner.file !== file;
      })
      .sort();
    expect(
      orphans,
      'a household pass was added for an event that HOUSEHOLD_PASS_OWNERS does not list against that file. Add it, so the next reader can tell which evaluator owns the room\'s copy of which event',
    ).toEqual([]);
  });

  it('gives every entry a reason', () => {
    const thin = Object.entries(HOUSEHOLD_PASS_OWNERS)
      .filter(([, owner]) => owner.why.trim().length < 40)
      .map(([eventId]) => eventId);
    expect(thin, 'every entry needs a sentence, from the code, saying how this event reaches the family channel').toEqual([]);
    for (const [eventId, owner] of Object.entries(HOUSEHOLD_PASS_OWNERS)) {
      expect(fs.existsSync(path.join(ROOT, owner.file)), `${eventId} names ${owner.file}, which no longer exists`).toBe(true);
    }
  });
});
