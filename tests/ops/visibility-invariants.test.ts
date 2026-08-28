import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * Ruling R2 / item AF. The reader boundary is six modules deep and nothing in the type system says
 * "this function returns other people's money" -- so this is the second, independent guard: every
 * read-model helper a PAGE OR ROUTE calls must take a viewer.
 *
 * Micro-ruling M3: this is a NAMED require-list, not a blanket scan for every exported get-or-list
 * function.
 * Taken literally, a blanket scan pulls in internal resolvers no page ever calls with a user-supplied
 * id, and a guard that fails for a correct reason nobody can act on is a guard people delete. The
 * exempt list below carries the reason for each exemption, and adding to it is a decision somebody
 * has to write down.
 */
const REQUIRE_VIEWER: { file: string; fn: string }[] = [
  { file: 'src/lib/transactions.ts', fn: 'listTransactions' },
  { file: 'src/lib/transactions.ts', fn: 'getTransaction' },
  { file: 'src/lib/accounts.ts', fn: 'listAccounts' },
  { file: 'src/lib/goals.ts', fn: 'listGoals' },
  { file: 'src/lib/goals.ts', fn: 'getGoal' },
  { file: 'src/lib/goals.ts', fn: 'listContributions' },
  { file: 'src/lib/loans.ts', fn: 'listLoans' },
  { file: 'src/lib/warranty/items.ts', fn: 'getWarrantyItem' },
  { file: 'src/lib/warranty/search.ts', fn: 'searchWarrantyItems' },
  { file: 'src/lib/warranty/search.ts', fn: 'expiringSoonItems' },
  { file: 'src/lib/reports.ts', fn: 'categoryBreakdown' },
  { file: 'src/lib/reports.ts', fn: 'cashflowTrend' },
  { file: 'src/lib/reports.ts', fn: 'categoryMonthOverMonth' },
  { file: 'src/lib/reports.ts', fn: 'categoryYearOverYear' },
  { file: 'src/lib/reports.ts', fn: 'personSpendSplit' },
  { file: 'src/lib/reports.ts', fn: 'topMerchants' },
  { file: 'src/lib/reports.ts', fn: 'transactionsCsv' },
  { file: 'src/lib/bills.ts', fn: 'upcomingBills' },
  { file: 'src/lib/bills.ts', fn: 'safeToSpend' },
  { file: 'src/lib/bills.ts', fn: 'sinkingFundsFor' },
  { file: 'src/lib/insights.ts', fn: 'householdInsights' },
];

/** Exempt, WITH the reason. Nothing is exempt without one. */
const EXEMPT: { file: string; fn: string; why: string }[] = [
  {
    file: 'src/lib/accounts.ts',
    fn: 'getAccount',
    why: 'internal resolver: createManualTransaction, commitImport and commitStagedImport call it with an id they produced themselves and have no viewer to pass. No page or route resolves a user-supplied account id through it.',
  },
];

describe('ruling R2: every read-model helper takes a viewer', () => {
  for (const { file, fn } of REQUIRE_VIEWER) {
    it(`${file} :: ${fn}`, () => {
      const source = read(file);
      const signature = new RegExp(`export function ${fn}\\b[\\s\\S]{0,600}?\\)\\s*:`, 'm').exec(source)?.[0];
      expect(signature, `${fn} is not exported from ${file}`).toBeTruthy();
      expect(signature).toMatch(/viewer\s*:\s*Viewer|viewer:\s*Viewer/);
      // Required, not optional: an optional viewer lets a forgotten call site compile into a leak.
      expect(signature).not.toMatch(/viewer\?\s*:/);
    });
  }

  it('every exemption carries a written reason', () => {
    for (const entry of EXEMPT) expect(entry.why.length).toBeGreaterThan(40);
  });

  it('is non-vacuous: the require-list and exempt-list together name at least 20 functions', () => {
    expect(REQUIRE_VIEWER.length + EXEMPT.length).toBeGreaterThanOrEqual(20);
  });
});

describe('ruling R3: the audit log is append-only', () => {
  it('nothing under src/ updates or deletes an audit_log row', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.join(root, 'src'));
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const name = path.relative(root, file).replace(/\\/g, '/');
      expect({ name, bad: /\.update\(\s*auditLog\s*\)|\.delete\(\s*auditLog\s*\)/.test(source) })
        .toEqual({ name, bad: false });
    }
  });
});

describe('ruling R1: no tenancy crept in', () => {
  it('no schema column or table is named for a household or tenant id', () => {
    const schema = read('src/db/schema.ts');
    expect(schema).not.toMatch(/household_id|householdId|tenant_id|tenantId/);
    for (const file of fs.readdirSync(path.join(root, 'drizzle')).filter((n) => n.endsWith('.sql'))) {
      expect(read(`drizzle/${file}`)).not.toMatch(/household_id|tenant_id/);
    }
  });
});
