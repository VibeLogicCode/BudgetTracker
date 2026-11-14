import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { planYearEndPack, yearEndDetailCsv, yearEndPackEstimate, yearEndPackLine, yearEndTooLargeMessage, type YearEndPlan } from '@/lib/year-end';
import { zipLength, zipStream } from '@/lib/zip-stream';
import { buildYearEndFixture, type YearEndFixture } from '../helpers/year-end-fixture';
import { readZip } from '../helpers/zip-read';

/**
 * v1.63.0 (plan 2026-11-12, B4). The year-end pack's plan: which rows, which receipts, and which
 * receipts are named but not carried.
 */

let fx: YearEndFixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

const TODAY = '2027-01-15';

function names(plan: YearEndPlan): string[] {
  return plan.entries.map((entry) => entry.name);
}

function text(plan: YearEndPlan, name: string): string {
  const entry = plan.entries.find((candidate) => candidate.name === name);
  if (!entry || !Buffer.isBuffer(entry.source)) throw new Error(`no text entry ${name}`);
  return entry.source.toString('utf8');
}

/** The detail CSV's data lines, by description column. */
function detailLines(plan: YearEndPlan): string[] {
  return text(plan, 'tax-detail-2026.csv').trim().split('\r\n');
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('planYearEndPack', () => {
  it('admin: the two CSVs, the README and both receipts', async () => {
    fx = buildYearEndFixture();
    const { r1, r2 } = fx.receipts;
    const plan = planYearEndPack(2026, fx.viewers.admin, { today: TODAY });
    expect(names(plan)).toEqual([
      'README.txt',
      'tax-detail-2026.csv',
      'tax-totals-2026.csv',
      `receipts/2026-02-03_PHARMACY-PLUS_r${r1.id}.pdf`,
      `receipts/2026-04-14_CITY-CLINIC_r${r2.id}.jpg`,
    ]);
    expect(plan).toMatchObject({
      receiptCount: 2,
      receiptBytes: r1.bytes.length + r2.bytes.length,
      omitted: { heldByOthers: 0, missing: 0 },
      tooLarge: false,
      tooLargeMessage: null,
    });
    expect(detailLines(plan)).toEqual([
      'Date,Account,Description,Category,Tax category,Person,Amount,Notes,Receipt files,Receipts not included',
      `2026-02-03,Joint chequing,PHARMACY PLUS,Medical > Pharmacy,Medical,Alex,-42.17,,receipts/2026-02-03_PHARMACY-PLUS_r${r1.id}.pdf,`,
      '2026-02-10,Joint chequing,PHARMACY PLUS,Medical > Pharmacy,Medical,Alex,10.00,,,',
      `2026-04-14,Joint chequing,CITY CLINIC,Medical,Medical,Sam,-120.00,,receipts/2026-04-14_CITY-CLINIC_r${r2.id}.jpg,`,
      '2026-06-01,Joint chequing,COMMUNITY FUND,Charity,Charity,Alex,-60.00,,,',
    ]);
    expect(text(plan, 'README.txt')).toContain('Year-end pack for 2026, made 2027-01-15. Rows for the whole household.');

    // The entries stream into a zip whose files are exactly these bytes.
    const zip = await collect(zipStream(plan.entries));
    expect(zip.length).toBe(zipLength(plan.entries));
    const read = readZip(zip);
    expect(read.map((entry) => entry.name)).toEqual(names(plan));
    expect(read[3].data.equals(r1.bytes)).toBe(true);
    expect(read[4].data.equals(r2.bytes)).toBe(true);
  });

  it("household member Alex: r1 only, and CITY CLINIC's row says who holds its receipt", () => {
    fx = buildYearEndFixture();
    const plan = planYearEndPack(2026, fx.viewers.household(fx.alex), { today: TODAY });
    expect(names(plan)).toEqual(['README.txt', 'tax-detail-2026.csv', 'tax-totals-2026.csv', `receipts/2026-02-03_PHARMACY-PLUS_r${fx.receipts.r1.id}.pdf`]);
    expect(plan.omitted).toEqual({ heldByOthers: 1, missing: 0 });
    expect(detailLines(plan).find((line) => line.includes('CITY CLINIC'))).toBe(
      '2026-04-14,Joint chequing,CITY CLINIC,Medical,Medical,Sam,-120.00,,,1 held by Sam',
    );
  });

  it("self viewer Alex: his own rows and r1, and nothing of Sam's in any entry", () => {
    fx = buildYearEndFixture();
    const plan = planYearEndPack(2026, fx.viewers.self(fx.alex), { today: TODAY });
    expect(names(plan)).toEqual(['README.txt', 'tax-detail-2026.csv', 'tax-totals-2026.csv', `receipts/2026-02-03_PHARMACY-PLUS_r${fx.receipts.r1.id}.pdf`]);
    expect(detailLines(plan).slice(1).map((line) => line.split(',').slice(0, 3).join(','))).toEqual([
      '2026-02-03,Joint chequing,PHARMACY PLUS',
      '2026-02-10,Joint chequing,PHARMACY PLUS',
      '2026-06-01,Joint chequing,COMMUNITY FUND',
    ]);
    expect(text(plan, 'README.txt')).toContain('Rows for Alex only.');
    expect(text(plan, 'tax-totals-2026.csv')).toBe('Category,Person,Amount\r\nCharity,Alex,60.00\r\nMedical,Alex,32.17\r\n');
    for (const entry of plan.entries) {
      const body = Buffer.isBuffer(entry.source) ? entry.source.toString('utf8') : fs.readFileSync(entry.source.path, 'utf8');
      for (const forbidden of ['Sam', 'CITY CLINIC', '120.00', '40.00', 'Dining', 'Household/unattributed']) {
        expect(body, `${entry.name} carries ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('a self viewer is told a receipt is held by someone else, never by whom', () => {
    fx = buildYearEndFixture();
    // Sam keeps the receipt for the charity Alex's part of COMMUNITY FUND belongs to.
    fx.addReceipt({ owner: fx.sam, txnId: fx.txn.fund });
    const plan = planYearEndPack(2026, fx.viewers.self(fx.alex), { today: TODAY });
    expect(detailLines(plan).find((line) => line.includes('COMMUNITY FUND'))).toBe(
      '2026-06-01,Joint chequing,COMMUNITY FUND,Charity,Charity,Alex,-60.00,,,1 held by someone else',
    );
  });

  it('a receipt whose file is gone is listed as missing and has no entry', () => {
    fx = buildYearEndFixture();
    fs.rmSync(fx.receipts.r2.path);
    const plan = planYearEndPack(2026, fx.viewers.admin, { today: TODAY });
    expect(names(plan)).not.toContain(`receipts/2026-04-14_CITY-CLINIC_r${fx.receipts.r2.id}.jpg`);
    expect(plan.omitted).toEqual({ heldByOthers: 0, missing: 1 });
    expect(plan.receiptCount).toBe(1);
    expect(detailLines(plan).find((line) => line.includes('CITY CLINIC'))).toMatch(/,1 missing from this install$/);
  });

  it('a stored name the receipts directory would refuse is treated as missing, never read', () => {
    fx = buildYearEndFixture();
    fx.t.sqlite.prepare('update warranty_receipts set stored_filename = ? where id = ?').run('../budget.db', fx.receipts.r2.id);
    const plan = planYearEndPack(2026, fx.viewers.admin, { today: TODAY });
    expect(plan.omitted.missing).toBe(1);
    expect(plan.entries.every((entry) => Buffer.isBuffer(entry.source) || !entry.source.path.endsWith('budget.db'))).toBe(true);
  });

  it('includes a receipt linked through a paid bill installment', () => {
    fx = buildYearEndFixture();
    const bill = fx.addReceipt({ owner: fx.alex, txnId: fx.txn.fund, via: 'bill', mime: 'image/png', itemName: 'Pledge' });
    const plan = planYearEndPack(2026, fx.viewers.admin, { today: TODAY });
    expect(names(plan)).toContain(`receipts/2026-06-01_COMMUNITY-FUND_r${bill.id}.png`);
    expect(plan.receiptCount).toBe(3);
  });

  it('a receipt linked to no tax row stays out', () => {
    fx = buildYearEndFixture();
    fx.addReceipt({ owner: fx.alex, txnId: fx.txn.grocer });
    expect(planYearEndPack(2026, fx.viewers.admin, { today: TODAY }).receiptCount).toBe(2);
  });

  it('maxReceiptBytes 1 marks the plan too large, with the sentence the route sends', () => {
    fx = buildYearEndFixture();
    const plan = planYearEndPack(2026, fx.viewers.admin, { today: TODAY, maxReceiptBytes: 1 });
    expect(plan.tooLarge).toBe(true);
    expect(plan.tooLargeMessage).toBe(
      `This year's receipts come to ${plan.receiptBytes} bytes, more than the 1 byte one pack can carry. Download the detail CSV, and the receipts from each item.`,
    );
  });

  it('the README says so far for the current year', () => {
    fx = buildYearEndFixture();
    expect(text(planYearEndPack(2026, fx.viewers.admin, { today: '2026-11-13' }), 'README.txt')).toContain(
      'Year-end pack for 2026 so far, made 2026-11-13.',
    );
  });
});

describe('yearEndDetailCsv', () => {
  it('is the very file the pack carries', () => {
    fx = buildYearEndFixture();
    const plan = planYearEndPack(2026, fx.viewers.household(fx.alex), { today: TODAY });
    expect(yearEndDetailCsv(2026, fx.viewers.household(fx.alex))).toBe(text(plan, 'tax-detail-2026.csv'));
  });

  it('neutralises a description that starts like a formula', () => {
    fx = buildYearEndFixture();
    fx.t.sqlite.prepare('update transactions set display_description = ? where id = ?').run('=HYPERLINK("x")', fx.txn.clinic);
    const csv = yearEndDetailCsv(2026, fx.viewers.admin);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });
});

describe('yearEndPackEstimate', () => {
  it("equals the plan's count and bytes when every file is present", () => {
    fx = buildYearEndFixture();
    for (const viewer of [fx.viewers.admin, fx.viewers.household(fx.alex), fx.viewers.self(fx.alex), fx.viewers.self(fx.sam)]) {
      const plan = planYearEndPack(2026, viewer, { today: TODAY });
      const estimate = yearEndPackEstimate(2026, viewer);
      expect([estimate.receiptCount, estimate.receiptBytes]).toEqual([plan.receiptCount, plan.receiptBytes]);
      expect(estimate.tooLarge).toBe(false);
    }
  });

  it('reads the line the card shows', () => {
    expect(yearEndPackLine({ receiptCount: 12, receiptBytes: Math.round(8.35 * 1024 * 1024), heldByOthers: 0, tooLarge: false, tooLargeMessage: null })).toBe(
      'Includes 12 receipts, 8.4 MB.',
    );
    expect(yearEndPackLine({ receiptCount: 1, receiptBytes: 25, heldByOthers: 0, tooLarge: false, tooLargeMessage: null })).toBe(
      'Includes 1 receipt, 25 bytes.',
    );
    expect(yearEndPackLine({ receiptCount: 0, receiptBytes: 0, heldByOthers: 1, tooLarge: false, tooLargeMessage: null })).toBe('Includes no receipts.');
    const over = yearEndTooLargeMessage(40, Math.round(2.35 * 1024 ** 3));
    expect(over).toBe(
      "This year's receipts come to 2.4 GB, more than the 2 GB one pack can carry. Download the detail CSV, and the receipts from each item.",
    );
    expect(yearEndPackLine({ receiptCount: 40, receiptBytes: 0, heldByOthers: 0, tooLarge: true, tooLargeMessage: over })).toBe(over);
  });
});
