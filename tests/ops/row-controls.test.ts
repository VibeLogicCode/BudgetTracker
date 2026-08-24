import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsxFiles(rel));
    else if (entry.name.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

const SUBMIT = /<SubmitButton\b|type="submit"/;

/**
 * The idiom v1.11.0 removed, and the one way it comes back.
 *
 * A per-row edit used to be a <form> holding one <select> and a Save button. Ruling R1 replaced
 * every one of those with an auto-save control, and the width that freed is what let four
 * tables stop scrolling sideways on a desktop. Nothing stops a future row control being written
 * the old way, though -- it is the obvious shape if you have not read the spec -- and each one
 * silently re-widens its table. So the shape is asserted against, not the outcome.
 *
 * The unit scanned is a <form> block. HTML forms cannot nest, so an open-tag-to-close-tag
 * non-greedy match is an unambiguous block rather than a guess -- which a <td>-to-</td> match
 * would not be, since cells nest inside rows inside tables inside cells (the accounts editor
 * row is a <td colSpan={9}> containing a whole form). Attributes are read off opening tags
 * only, the same discipline table-layout.test.ts applies to <TableWrap.
 *
 * A form is an offence when ALL of these hold:
 *   - it contains exactly one <select
 *   - every <input in it is type="hidden" (so the select is its only editable control -- this
 *     is what exempts real editor forms like the accounts row, which carries four fields and
 *     one Save, and the "Add a user" card, which carries three)
 *   - it has no <textarea
 *   - it has a submit control
 *   - it writes ONE row
 *
 * That last clause is the spec's safety rule, not a convenience: an action that writes many
 * rows KEEPS its deliberate button, so it cannot be an offence. Two such forms exist and must
 * stay -- review's "Apply to all N matching" (keyed by a merchant, not a row) and the
 * transactions bulk toolbar (`value={selected.join(',')}`) -- and they are recognised by what
 * they submit rather than by being named in a list here. A per-row form reintroduced in either
 * of those files is still caught, which an allowlist of files would not manage.
 */
describe('no table row pairs a lone select with a Save button', () => {
  const offenders: string[] = [];
  let autoSaveSelects = 0;
  let filesScanned = 0;

  for (const rel of tsxFiles('src/app')) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    filesScanned += 1;
    autoSaveSelects += [...source.matchAll(/<AutoSaveSelect\b/g)].length;

    for (const match of source.matchAll(/<form\b[\s\S]*?<\/form>/g)) {
      const block = match[0];
      if ([...block.matchAll(/<select\b/g)].length !== 1) continue;
      const inputs = [...block.matchAll(/<input\b[^>]*>/g)].map((tag) => tag[0]);
      const hidden = inputs.filter((tag) => /type="hidden"/.test(tag));
      if (inputs.length !== hidden.length) continue;
      if (/<textarea\b/.test(block)) continue;
      if (!SUBMIT.test(block)) continue;
      // A joined id list, or a merchant key rather than a row id: a multi-row write, which the
      // safety rule says keeps its button.
      if (hidden.some((tag) => /\.join\(/.test(tag) || /name="normalizedMerchant"/.test(tag))) continue;
      const line = source.slice(0, match.index ?? 0).split(/\r?\n/).length;
      offenders.push(`${rel}:${line}`);
    }
  }

  it('every single-row select control saves itself instead of carrying a Save button', () => {
    expect(offenders).toEqual([]);
  });

  it('finds the auto-save controls, so the check above cannot pass vacuously', () => {
    // A floor, not a count. Five conversions land in src/app: the transactions category and
    // person cells, review's fix-category, import's cardholder person, and the item-type kind.
    // Adding a sixth must not fail here -- removing the guard's ability to see any of them
    // must.
    expect(filesScanned).toBeGreaterThan(0);
    expect(autoSaveSelects).toBeGreaterThanOrEqual(5);
  });
});
