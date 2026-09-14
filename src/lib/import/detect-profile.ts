import type { ImportMapping } from './mapping';
import { looksLikeOfx } from './ofx';
import { parseCsv } from './parse';

/**
 * One profile the household actually has, as the import page offers it: active, with a readable
 * mapping (see ProfileRecord.mappingError and hasReadableMapping in presets.ts). The detector is
 * never given the full preset catalogue -- a profile that has been deactivated is not an answer
 * this page may give, so it is not a candidate here either.
 */
export interface ProfileCandidate {
  id: number;
  name: string;
  mapping: ImportMapping;
}

export interface ProfileScore {
  profileId: number;
  name: string;
  /** Rows this mapping read without an error, over every row it tried. 0 when it read nothing. */
  cleanRate: number;
  parsedRows: number;
  errorRows: number;
  /**
   * How many of the file's OWN columns this mapping accounts for. Two presets can describe one
   * layout -- CIBC Chequing/Visa is TD Chequing/Debit without the balance column -- and then the
   * clean rates are identical and this is what separates them. A mapping that leaves a column of
   * the file unexplained is a poorer description of it than one that reads every column.
   */
  coverage: number;
}

export interface ProfileDetection {
  /** The profile to pre-select, or null when the file is OFX, unreadable, or genuinely ambiguous. */
  profile: { id: number; name: string } | null;
  /**
   * `certain` -- one profile read the whole file and nothing else came close; safe to pre-select
   * and say so. `likely` -- one profile is clearly ahead but left rows unread, so the preview is
   * doing the real work of confirming it. `none` -- nothing readable, or two profiles too close
   * to separate; the caller must leave the picker where it was and say why.
   */
  confidence: 'certain' | 'likely' | 'none';
  /** A sentence for the screen. Always populated, including when nothing was picked. */
  reason: string;
  source: 'csv' | 'ofx';
  /** Every candidate, best first -- so a caller can show the runners-up rather than only the winner. */
  scores: ProfileScore[];
}

/**
 * Every column index a mapping actually consumes, capped at the file's own width: a mapping that
 * names a column the file does not have is not explaining anything by naming it.
 */
function coverageOf(mapping: ImportMapping, columnCount: number): number {
  const indexes = new Set<number>([
    mapping.dateCol,
    ...mapping.descCols,
    ...(mapping.amountCol === null ? [] : [mapping.amountCol]),
    ...(mapping.debitCol === null ? [] : [mapping.debitCol]),
    ...(mapping.creditCol === null ? [] : [mapping.creditCol]),
    ...(mapping.balanceCol === null || mapping.balanceCol === undefined ? [] : [mapping.balanceCol]),
    ...(mapping.cardCol === null || mapping.cardCol === undefined ? [] : [mapping.cardCol]),
  ]);
  return [...indexes].filter((index) => index >= 0 && index < columnCount).length;
}

/**
 * A mapping has to read nearly all of a file before its answer is worth pre-selecting. Below
 * this, something is wrong -- the wrong bank, the wrong date format, a file that is not a
 * statement at all -- and a confident pick would just be a confident mistake.
 */
const CERTAIN_CLEAN_RATE = 0.95;
/** Enough to be worth offering, with the preview as the check. Below it, nothing is pre-selected. */
const MINIMUM_CLEAN_RATE = 0.6;
/**
 * How far ahead of the runner-up the winner has to be. Two profiles that read a file equally well
 * are not separable BY THIS EVIDENCE, and saying so is more useful than a coin toss -- for two
 * genuinely similar layouts the preview (and the household) can tell them apart and this cannot.
 */
const MARGIN = 0.15;
/**
 * Parsing every row of a large statement five times over, to choose a picker's default, is work
 * nobody asked for. The first 200 data rows separate any two real bank layouts many times over.
 */
const SAMPLE_ROWS = 200;

function sample(buf: Buffer): Buffer {
  const text = buf.toString('binary');
  let cut = 0;
  for (let i = 0; i < SAMPLE_ROWS; i += 1) {
    const next = text.indexOf('\n', cut);
    if (next === -1) return buf;
    cut = next + 1;
  }
  return buf.subarray(0, Buffer.byteLength(text.slice(0, cut), 'binary'));
}

/**
 * Which of the profiles this household has can READ this file, decided by running each mapping
 * over the file and counting what comes back -- not by a table of bank fingerprints. presets.ts
 * already describes every built-in layout once; a second description of the same layouts is the
 * thing that goes stale the first time a bank changes its export, and it would say nothing at all
 * about the custom profiles a household built for its own bank.
 *
 * Scoring is deliberately blunt: the share of rows a mapping read without an error. A wrong date
 * format fails every row ('unparseable date'), a wrong amount column fails every row
 * ('unparseable amount' / 'missing amount'), and a mapping pointed at the wrong bank's column
 * count fails on the description or the amount. So the right profile does not merely win, it wins
 * by a wide margin -- which is what MARGIN below checks, rather than trusting first place alone.
 *
 * Never decides anything on its own: the caller pre-selects the picker with this and shows the
 * preview built from it, which is where a wrong mapping becomes visible (dates in the wrong
 * century, amounts in the wrong column) before a single row is committed.
 */
export function detectImportProfile(input: {
  buf: Buffer;
  filename: string;
  candidates: ProfileCandidate[];
}): ProfileDetection {
  // Ruling R9's dispatch, borrowed: an OFX/QFX file names its own fields, so commitStagedImport
  // passes `mapping: null` for one and there is no profile to choose. Checked by content as well
  // as extension, exactly as flow.ts and buildPreview do -- an extension alone is a claim.
  if (looksLikeOfx(input.filename, input.buf)) {
    return {
      profile: null,
      confidence: 'certain',
      reason: 'This is an OFX/QFX file, which names its own columns — no import profile is needed.',
      source: 'ofx',
      scores: [],
    };
  }

  const head = sample(input.buf);
  const scores: ProfileScore[] = input.candidates
    .map((candidate) => {
      const parsed = parseCsv(head, candidate.mapping);
      const attempted = parsed.rows.length + parsed.errors.length;
      const columnCount = Math.max(
        0,
        ...parsed.rows.map((row) => row.cells.length),
        ...parsed.errors.map((row) => row.cells.length),
      );
      return {
        profileId: candidate.id,
        name: candidate.name,
        cleanRate: attempted === 0 ? 0 : parsed.rows.length / attempted,
        parsedRows: parsed.rows.length,
        errorRows: parsed.errors.length,
        coverage: coverageOf(candidate.mapping, columnCount),
      };
    })
    // Coverage before rows read: a dead heat on clean rate is the two-presets-one-layout case,
    // where the answer is whichever mapping explains more of the file. Rows read is the last
    // tie-break -- forty rows read cleanly beats two, even though both scored 1.
    .sort((a, b) => b.cleanRate - a.cleanRate || b.coverage - a.coverage || b.parsedRows - a.parsedRows);

  const best = scores[0];
  if (best === undefined || best.parsedRows === 0 || best.cleanRate < MINIMUM_CLEAN_RATE) {
    return {
      profile: null,
      confidence: 'none',
      reason: 'None of your import profiles could read this file. Pick the one that matches, or add a bank.',
      source: 'csv',
      scores,
    };
  }

  // Ambiguity is a tie the tie-breaks could not settle: as readable as each other AND explaining
  // the file equally well. When one mapping covers more columns it has genuinely won, so the
  // margin check below does not get to overrule it.
  const runnerUp = scores[1];
  if (runnerUp !== undefined && best.cleanRate - runnerUp.cleanRate < MARGIN && best.coverage <= runnerUp.coverage) {
    return {
      profile: null,
      confidence: 'none',
      reason: `This file reads about as well as ${best.name} as it does as ${runnerUp.name}, so it was left for you to choose.`,
      source: 'csv',
      scores,
    };
  }

  const attempted = best.parsedRows + best.errorRows;
  const confidence = best.cleanRate >= CERTAIN_CLEAN_RATE ? 'certain' : 'likely';
  return {
    profile: { id: best.profileId, name: best.name },
    confidence,
    reason:
      confidence === 'certain'
        ? `${best.name} read all ${attempted} of ${attempted} rows in this file.`
        : `${best.name} read ${best.parsedRows} of ${attempted} rows. Check the preview before you commit.`,
    source: 'csv',
    scores,
  };
}
