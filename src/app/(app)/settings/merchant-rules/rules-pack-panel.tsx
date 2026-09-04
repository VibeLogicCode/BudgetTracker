'use client';

// v1.21.0 (item 10): moved here verbatim from src/app/(app)/settings/managers/rules-pack-panel.tsx
// when the whole "Merchant rules" surface moved off /settings/managers -- sharing a rules pack
// with another install is a rule concern, not a categories-and-profiles concern, so it belongs
// beside the rules it exports/imports rather than left behind as a second surface for the same
// data. Nothing in this component changed: it hits its own dedicated API routes
// (/api/packs/rules/export, /api/packs/rules/import), which are unaffected by which page renders it.

import { useState } from 'react';
import { Notice } from '@/components/ui/Notice';
import { selectClass } from '@/components/ui/form';
import type { RulesExportRow } from '@/lib/packs';

interface ImportPreview {
  applied: false;
  totalRules: number;
  newRules: number;
  unchanged: number;
  transferRules: number;
  skippedRules: number;
  /** v1.31.0 R-12: the skipped entries BY NAME, each with its reason. A count on its own told a
   *  household four rules would not arrive and gave them no way to find out which four. */
  skipped: { pattern: string; matchType: string; ruleKind: string; reason: string }[];
  /** v1.31.0 M-3: of the `unchanged` entries, the ones this install has switched OFF. They are
   *  left off -- that is the household's own decision -- but saying nothing made a partly-inert
   *  import look like a complete one. */
  inert: { pattern: string; matchType: string; ruleKind: string; reason: string }[];
  conflicts: {
    pattern: string;
    matchType: string;
    existingCategory: string | null;
    incomingCategory: string | null;
    existingRenameTo?: string | null;
    incomingRenameTo?: string | null;
  }[];
  newCategories: string[];
  /** v1.31.0 R-13: categories a rule will bind to that are ARCHIVED here -- money filed into one
   *  of these shows up in no spend report, so it is said before the click, not after. */
  archivedCategories: string[];
}

/** v1.31.0 R-12, widened by M-3 to take the key. The patterns the server named under `key`, read
 *  defensively off an untyped JSON body: this panel already treats the response as
 *  `Record<string, unknown>` (R-04's fix), and a count with no names was the defect, so a missing
 *  or malformed list degrades to "say nothing extra" rather than to a thrown render. One reader
 *  for both lists rather than a second copy of the same five lines. */
function namedPatterns(body: Record<string, unknown>, key: 'rulesSkippedDetail' | 'rulesInertDetail'): string[] {
  const detail = body[key];
  if (!Array.isArray(detail)) return [];
  return detail
    .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as { pattern?: unknown }).pattern : null))
    .filter((pattern): pattern is string => typeof pattern === 'string');
}

const fileInputClass =
  'text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-accent-soft-fg';

export function RulesPackPanel({ rows }: { rows: RulesExportRow[] }) {
  const [includeTransfers, setIncludeTransfers] = useState(false);
  // Off by default (controller ruling (a), src/lib/packs.ts): a rename's text is something a
  // household member typed, and it can name a real person -- "Loan to Sam", "Rent from Alex".
  // Unlike a category rule (a pattern plus a category id) that text is a genuine disclosure risk,
  // so it needs its own explicit opt-in rather than riding along with includeTransfers.
  const [includeRenames, setIncludeRenames] = useState(false);
  const [excluded, setExcluded] = useState<number[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [onConflict, setOnConflict] = useState<'keep' | 'overwrite'>('keep');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const visible = rows.filter((row) => {
    if (row.ruleKind === 'transfer') return includeTransfers;
    if (row.ruleKind === 'rename') return includeRenames;
    return true;
  });
  // v1.31.0 R-14: a disabled rule is LISTED (so its absence from the file is explained) but never
  // exported and never counted -- see exportRulesPack, which drops it, and RulesExportRow.disabled
  // for why marking beats hiding.
  const exportable = visible.filter((row) => !row.disabled);
  const exportHref = `/api/packs/rules/export?includeTransfers=${includeTransfers ? '1' : '0'}&includeRenames=${includeRenames ? '1' : '0'}&exclude=${excluded.join(',')}`;
  const toggle = (id: number) => setExcluded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  async function send(mode: 'preview' | 'apply') {
    if (!file) {
      setError('Choose a pack file first.');
      return;
    }
    setError(null);
    setNotice(null);
    const form = new FormData();
    form.append('file', file);
    form.append('mode', mode);
    form.append('onConflict', onConflict);
    // v1.31.0 R-04: both the fetch AND the JSON parse are inside the try. Neither used to be, and
    // `send` is called from a floating `void send('apply')`, so a 500 with an HTML body (which is
    // what an unexpected server error is) rejected here unhandled and the person saw the panel
    // simply do nothing. A response this component cannot read is still something it has to say.
    let response: Response;
    let body: Record<string, unknown>;
    try {
      response = await fetch('/api/packs/rules/import', { method: 'POST', body: form });
      body = await response.json();
    } catch {
      setError('Import failed. Nothing was changed. Check the file and try again.');
      setPreview(null);
      return;
    }
    if (!response.ok) {
      setError(typeof body.error === 'string' ? body.error : 'Import failed.');
      setPreview(null);
      return;
    }
    if (mode === 'preview') {
      setPreview(body as unknown as ImportPreview);
      return;
    }
    setPreview(null);
    const count = (key: string) => Number(body[key] ?? 0);
    const skipped = namedPatterns(body, 'rulesSkippedDetail');
    // M-3: the rules that were already here, unchanged -- and the ones among them this install has
    // switched off, which the import deliberately left off and used to mention nowhere at all.
    const inert = namedPatterns(body, 'rulesInertDetail');
    setNotice(
      `Added ${count('rulesAdded')} rules, overwrote ${count('rulesOverwritten')}, kept ${count('rulesKept')} existing, left ${count('rulesUnchanged')} unchanged, created ${count('categoriesCreated')} categories.` +
        // R-12: the apply message names them too, not only the preview -- an import reached
        // through "Import" without a Preview click is the case where a bare count is least useful.
        (skipped.length > 0 ? ` Skipped ${skipped.length}: ${skipped.join(', ')}.` : '') +
        (inert.length > 0
          ? ` ${inert.length} of the unchanged ${inert.length === 1 ? 'rule is' : 'rules are'} switched off here and stayed off: ${inert.join(', ')}.`
          : ''),
    );
    window.location.reload();
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2/50 p-4 text-sm">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-ink">Share rules with another install</h3>
        <p className="text-xs text-muted">
          A rules pack carries only category names and merchant patterns. It never contains transactions, amounts, accounts, users, or the
          classifier&apos;s learned statistics.
        </p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <div className="flex flex-col gap-2">
        <h4 className="eyebrow">Export</h4>
        <label className="flex items-start gap-2 text-muted">
          <input
            type="checkbox"
            checked={includeTransfers}
            onChange={(e) => setIncludeTransfers(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          Include transfer rules (they can contain personal names from e-transfer descriptions)
        </label>
        <label className="flex items-start gap-2 text-muted">
          <input
            type="checkbox"
            checked={includeRenames}
            onChange={(e) => setIncludeRenames(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          Include rename rules (off by default: a rename&apos;s text is something you typed, and may name a
          person — &quot;Loan to Sam&quot;, &quot;Rent from Alex&quot;)
        </label>
        <p className="text-xs text-subtle">Everything ticked below will be written into the file. Untick anything you would rather not share.</p>
        <ul className="max-h-64 overflow-y-auto rounded-md border border-line bg-surface p-2">
          {visible.map((row) => (
            <li key={row.ruleId} className="flex items-center gap-2 py-0.5">
              {row.disabled ? (
                /* R-14: no checkbox. There is nothing to untick -- this rule is not in the file
                   either way -- and offering one would imply it otherwise would be. */
                <span aria-hidden className="inline-block w-4" />
              ) : (
                <input
                  type="checkbox"
                  checked={!excluded.includes(row.ruleId)}
                  onChange={() => toggle(row.ruleId)}
                  aria-label={`Include ${row.pattern}`}
                  className="accent-accent"
                />
              )}
              <code className={`font-mono text-xs ${row.disabled ? 'text-subtle line-through' : 'text-ink'}`}>{row.pattern}</code>
              <span className="text-xs text-subtle">
                {row.matchType}
                {row.ruleKind === 'transfer'
                  ? ' · transfer'
                  : row.ruleKind === 'rename'
                    ? ` → renamed to "${row.renameTo ?? ''}"`
                    : ` → ${row.categoryLabel ?? 'Uncategorized'}`}
                {row.disabled ? ' · (disabled, not exported)' : ''}
              </span>
            </li>
          ))}
          {visible.length === 0 ? <li className="px-1 py-2 text-xs text-subtle">No rules to export yet.</li> : null}
        </ul>
        <a href={exportHref} className="btn btn--primary w-fit">
          Download rules pack ({exportable.length - excluded.filter((id) => exportable.some((row) => row.ruleId === id)).length} rules)
        </a>
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <h4 className="eyebrow">Import</h4>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Rules pack file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className={fileInputClass}
        />
        <label className="flex flex-wrap items-center gap-2 text-muted">
          When a pattern already exists with a different category:
          <select
            value={onConflict}
            onChange={(e) => setOnConflict(e.target.value as 'keep' | 'overwrite')}
            className={`${selectClass} w-auto px-2 py-1 text-xs`}
          >
            <option value="keep">keep mine</option>
            <option value="overwrite">use theirs</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={() => void send('preview')} className="btn btn--secondary">Preview</button>
          <button type="button" onClick={() => void send('apply')} disabled={preview === null} className="btn btn--primary">
            Import
          </button>
        </div>
        {preview ? (
          <div className="flex flex-col gap-1 rounded-md border border-line bg-surface p-3 text-xs text-muted">
            <p>
              {preview.totalRules} rules in the file: <strong className="font-semibold text-ink">{preview.newRules} new</strong>,{' '}
              {preview.conflicts.length} conflicts, {preview.unchanged} already identical, {preview.transferRules} transfer rules.
            </p>
            {/* v1.31.0 R-12: named, not just counted. Which rule was dropped is the only version
                of this sentence a household can act on -- and the reason differs per entry (a
                kind this install will never import, versus a match type from a newer build,
                versus a pack-authoring mistake the sender can fix). */}
            {preview.skipped.length > 0 ? (
              <>
                <p>
                  {preview.skipped.length} rule{preview.skipped.length === 1 ? '' : 's'} will be skipped -- nothing about{' '}
                  {preview.skipped.length === 1 ? 'it' : 'them'} is written:
                </p>
                <ul className="list-inside list-disc">
                  {preview.skipped.map((skip, index) => (
                    <li key={`${skip.pattern}-${skip.matchType}-${skip.ruleKind}-${index}`}>
                      <code className="font-mono">{skip.pattern}</code> ({skip.matchType} {skip.ruleKind}) — {skip.reason}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {/* M-3: an identical rule the household has switched off is left off, and said so
                before the click. Its own paragraph rather than a line in the counts above,
                because "already identical" reads as "nothing to do here" and for these entries
                that is exactly the misunderstanding. */}
            {preview.inert.length > 0 ? (
              <p>
                {preview.inert.length} of the {preview.unchanged} identical rule
                {preview.unchanged === 1 ? '' : 's'} {preview.inert.length === 1 ? 'is' : 'are'} switched off here and will stay
                off: {preview.inert.map((entry) => entry.pattern).join(', ')}. Turn{' '}
                {preview.inert.length === 1 ? 'it' : 'them'} back on in the rules list if you want the pack&apos;s version to fire.
              </p>
            ) : null}
            {preview.newCategories.length > 0 ? <p>Categories to create: {preview.newCategories.join(', ')}</p> : null}
            {/* R-13: an archived category is still used (findCategory prefers a live one and only
                falls back), but never silently -- a rule filing into a retired category files
                money where no spend report shows it. */}
            {preview.archivedCategories.length > 0 ? (
              <p>
                Rules will be filed into {preview.archivedCategories.length === 1 ? 'an archived category' : 'archived categories'}:{' '}
                {preview.archivedCategories.join(', ')} — spending filed there appears in no report until you un-archive{' '}
                {preview.archivedCategories.length === 1 ? 'it' : 'them'}.
              </p>
            ) : null}
            {preview.conflicts.length > 0 ? (
              <ul className="mt-1 list-inside list-disc">
                {preview.conflicts.map((conflict) => (
                  <li key={`${conflict.pattern}-${conflict.matchType}`}>
                    <code className="font-mono">{conflict.pattern}</code>:{' '}
                    {conflict.existingRenameTo !== undefined || conflict.incomingRenameTo !== undefined ? (
                      <>
                        mine renames to {conflict.existingRenameTo ? `"${conflict.existingRenameTo}"` : 'none'} · theirs renames to{' '}
                        {conflict.incomingRenameTo ? `"${conflict.incomingRenameTo}"` : 'none'}
                      </>
                    ) : (
                      <>
                        mine {conflict.existingCategory ?? 'none'} · theirs {conflict.incomingCategory ?? 'none'}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
