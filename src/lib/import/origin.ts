/**
 * v1.61.0. How a transaction arrived (transactions.origin, drizzle/0031_no_double_counting.sql).
 *
 * PURE: no @/db import and no node builtin, so a client component can take the labels and types
 * from here (tests/ops/client-bundle.test.ts). The data itself reaches the client as props.
 */
export type RowOrigin = 'manual' | 'csv' | 'ofx' | 'simplefin';

/** The three roads an import takes. A set-aside row is always one of these. */
export type ImportOrigin = Exclude<RowOrigin, 'manual'>;

const LABELS: Record<RowOrigin, string> = {
  manual: 'added by hand',
  csv: 'from a CSV statement',
  ofx: 'from a QFX/OFX statement',
  simplefin: 'from SimpleFIN',
};

export function originLabel(origin: RowOrigin): string {
  return LABELS[origin];
}

/**
 * A row already in the account that an incoming row may be a second copy of. `description` is the
 * display name when there is one, else the bank's text.
 */
export interface DuplicateCandidate {
  id: number;
  date: string;
  description: string;
  amountCents: number;
  origin: RowOrigin;
  personName: string | null;
}
