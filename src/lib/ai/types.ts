import type { SuggestedFields } from '@/lib/warranty/suggest';

/**
 * v1.64.0. The local AI helper's shared shapes. PURE and type-only, so a client component imports
 * these with `import type` and never reaches the network file (tests/ops/client-bundle).
 */

/** The saved model server: an origin on the household's network, and the model it should run. */
export interface LocalAiConfig {
  baseUrl: string;
  model: string;
}

/** What Review shows for one merchant. Either part may be missing; a row with neither is not sent. */
export interface AiSuggestionView {
  categoryId: number | null;
  /** The category's display label, `Parent › Child`. */
  categoryLabel: string | null;
  cleanName: string | null;
}

/** The receipt poll's `ai` field. `off` covers turned off, not set up, and waiting after failures. */
export type AiReceiptPoll =
  | { status: 'off' }
  | { status: 'pending' }
  | { status: 'failed' }
  | { status: 'done'; fields: SuggestedFields };

/** Settings, Connections' one status line (localAiStatus). Times are ISO instants. */
export interface LocalAiStatus {
  state: 'off' | 'on' | 'waiting';
  /**
   * The admin's switch (local_ai_enabled), whatever `state` says. True with `state: 'off'` means the
   * saved address or model no longer passes the checks: off everywhere, but Settings offers Turn off.
   */
  enabled: boolean;
  lastOkAt: string | null;
  nextTryAt: string | null;
  failures: number;
  lastError: string | null;
  counts: AiSuggestionCounts;
}

export interface AiSuggestionCounts {
  suggested: number;
  ignored: number;
  failed: number;
  /** Merchants that would be asked about next: targets with no row yet. */
  toAsk: number;
}
