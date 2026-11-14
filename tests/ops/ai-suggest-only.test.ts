import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * v1.64.0 (plan 2026-11-12, A12). SUGGESTION ONLY. Nothing under src/lib/ai/ files a row, writes a
 * rule or touches a warranty record: a suggestion is used only when a person presses a button that
 * posts to an existing action (setCategoryAction, renameTransactionAction, reviewMerchantGroupAction),
 * with every guard those carry. This scans the tree, comments stripped, for a call to any filing or
 * rule writer, and for any insert, update or delete aimed at the four tables a suggestion must never
 * reach, written through drizzle or as SQL text. A broken snippet below proves each matcher.
 */
const ROOT = process.cwd();
const AI_DIR = 'src/lib/ai';

function walk(dir: string): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const WRITERS = [
  'confirmCategory',
  'clearCategory',
  'setTransferFlag',
  'applyCategoryToMatching',
  'createRulesFromRow',
  'upsertRenameRule',
  'setTransactionDisplayName',
  'bulkSetCategory',
  'bulkSetTransfer',
  'bulkSetAttribution',
  'runEngine',
  'rerunEngine',
  'applyRuleNow',
];
const WRITER_CALL = new RegExp(`\\b(${WRITERS.join('|')})\\s*\\(`);
const DRIZZLE_WRITE = /\.(insert|update|delete)\(\s*(transactions|merchantRules|warrantyItems|warrantyReceipts)\s*\)/;
const SQL_WRITE = /\b(insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from)\s+[`"']?(transactions|merchant_rules|warranty_items|warranty_receipts)\b/i;

function offences(source: string): string[] {
  const clean = stripComments(source);
  const found: string[] = [];
  const writer = WRITER_CALL.exec(clean);
  if (writer) found.push(`calls ${writer[1]}`);
  const drizzle = DRIZZLE_WRITE.exec(clean);
  if (drizzle) found.push(`${drizzle[1]}s ${drizzle[2]}`);
  const sql = SQL_WRITE.exec(clean);
  if (sql) found.push(`SQL ${sql[1].toLowerCase()} ${sql[2]}`);
  return found;
}

describe('A12: src/lib/ai/ suggests and never files', () => {
  const files = walk(AI_DIR);

  it('has the tree to scan, so a rename cannot make this vacuous', () => {
    expect(files).toEqual(expect.arrayContaining(['src/lib/ai/suggestions.ts', 'src/lib/ai/queue.ts', 'src/lib/ai/client.ts']));
  });

  it('no file calls a filing or rule writer, or writes transactions, merchant_rules or a warranty table', () => {
    const found = files.map((file) => ({ file, offences: offences(fs.readFileSync(path.join(ROOT, file), 'utf8')) })).filter((entry) => entry.offences.length > 0);
    expect(found).toEqual([]);
  });

  it('the one table it writes is ai_suggestions, from suggestions.ts alone', () => {
    const writers = files.filter((file) => /\.(insert|update|delete)\(\s*aiSuggestions\s*\)/.test(stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))));
    expect(writers).toEqual(['src/lib/ai/suggestions.ts']);
  });

  describe('each matcher catches a broken snippet', () => {
    it('a call to each writer', () => {
      for (const name of WRITERS) expect(offences(`engine.${name}({ txnId: 1 });`), name).toEqual([`calls ${name}`]);
      expect(offences('// confirmCategory({ txnId: 1 }) only in a comment')).toEqual([]);
      expect(offences('const confirmCategoryLabel = 1;')).toEqual([]);
    });

    it('a drizzle write to each table', () => {
      expect(offences('getDb().update(transactions).set({ categoryId: 3 }).run();')).toEqual(['updates transactions']);
      expect(offences('db.insert( merchantRules ).values(row).run();')).toEqual(['inserts merchantRules']);
      expect(offences('tx.delete(warrantyItems).run();')).toEqual(['deletes warrantyItems']);
      expect(offences('tx.update(warrantyReceipts).set({}).run();')).toEqual(['updates warrantyReceipts']);
      expect(offences('getDb().insert(aiSuggestions).values(row).run();')).toEqual([]);
    });

    it('a SQL write to each table', () => {
      expect(offences('sqlite.prepare("update transactions set category_id = 1")')).toEqual(['SQL update transactions']);
      expect(offences('sql`insert or replace into merchant_rules (pattern) values (1)`')).toEqual(['SQL insert or replace into merchant_rules']);
      expect(offences("db.run('DELETE FROM `warranty_items`')")).toEqual(['SQL delete from warranty_items']);
      expect(offences('select 1 from transactions')).toEqual([]);
    });
  });
});
