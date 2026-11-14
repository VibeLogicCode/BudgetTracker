import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { billInstallments, users, warrantyItems, warrantyReceipts } from '@/db/schema';
import { canActOnOwner, ownerScope, type Viewer } from '@/lib/auth/viewer';
import { toCsv, type CsvColumn } from '@/lib/reports';
import { taxDetailRows, taxYearCsv, type TaxDetailRow } from '@/lib/tax';
import { resolveReceiptPath } from '@/lib/warranty/receipts';
import { extForMime, RECEIPT_MIMES, type ReceiptMime } from '@/lib/warranty/sniff';
import type { ZipEntry } from '@/lib/zip-stream';

/**
 * v1.63.0 (plan 2026-11-12, Y1, Y2 and B4). The year-end pack: the tax detail CSV, the tax totals
 * CSV, a README and the receipts behind those rows, planned here and streamed by
 * src/lib/zip-stream.ts. Server-only (database and file system).
 *
 * Owner decisions (2026-11-12): a self-scoped member gets a pack over their OWN rows; a pack holds
 * only the receipts the downloader could open in the app today (canActOnOwner, the receipt route's
 * own rule), and every other receipt is named in the CSV as not included; a pack carries at most
 * 2 GB of receipts.
 *
 * Receipt files are found by the database alone: a receipt's stored name, checked by
 * resolveReceiptPath (the pattern and the directory), never anything a request carried.
 */

/** Owner decision 3: 2 GiB of receipts. Under the 4 GiB a zip without Zip64 can hold. */
export const YEAR_END_MAX_RECEIPT_BYTES = 2 * 1024 * 1024 * 1024;
/** Far under the 65,535 entries a zip without Zip64 can list. */
export const YEAR_END_MAX_RECEIPTS = 5000;

const ID_CHUNK = 400;

interface LinkedReceipt {
  txnId: number;
  receiptId: number;
  storedFilename: string;
  mime: string;
  sizeBytes: number;
  ownerUserId: number;
}

/**
 * Y1. The receipts of every item linked to one of `txnIds`, by the item's purchase
 * (warranty_items.transaction_id) or by a bill installment it paid (bill_installments.paid_txn_id).
 * One read per chunk of ids, both links in one union.
 */
function linkedReceipts(txnIds: number[]): LinkedReceipt[] {
  const out: LinkedReceipt[] = [];
  for (let offset = 0; offset < txnIds.length; offset += ID_CHUNK) {
    const ids = sql.join(
      txnIds.slice(offset, offset + ID_CHUNK).map((id) => sql`${id}`),
      sql`, `,
    );
    out.push(
      ...getDb().all<LinkedReceipt>(sql`
        select link.txn_id as txnId, r.id as receiptId, r.stored_filename as storedFilename, r.mime as mime,
               r.size_bytes as sizeBytes, i.owner_user_id as ownerUserId
        from (
          select id as item_id, transaction_id as txn_id from ${warrantyItems} where transaction_id in (${ids})
          union
          select item_id, paid_txn_id from ${billInstallments} where paid_txn_id in (${ids})
        ) as link
        join ${warrantyItems} as i on i.id = link.item_id
        join ${warrantyReceipts} as r on r.warranty_item_id = i.id
        order by link.txn_id, r.id`),
    );
  }
  return out;
}

type ReceiptState =
  | { kind: 'included'; zipName: string; date: string; size: number; path: string | null }
  | { kind: 'held'; ownerUserId: number }
  | { kind: 'missing' };

interface Gathered {
  rows: TaxDetailRow[];
  /** receipt id -> what happens to it, in the order the rows first reach it. */
  receipts: Map<number, ReceiptState>;
  /** transaction id -> its receipt ids. */
  receiptsByTxn: Map<number, number[]>;
  names: Map<number, string>;
}

/** A description cut to what a zip entry name may carry (zip-stream.ts: [A-Za-z0-9._/-]). */
function nameSafe(text: string): string {
  const safe = text
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return safe.length > 0 ? safe : 'receipt';
}

function isReceiptMime(mime: string): mime is ReceiptMime {
  return (RECEIPT_MIMES as readonly string[]).includes(mime);
}

/**
 * The file behind a stored name, or null when it cannot be served: a name resolveReceiptPath
 * refuses, no file (a database-only restore), or anything but a regular file.
 */
function receiptFile(storedFilename: string): { path: string; size: number } | null {
  try {
    const path = resolveReceiptPath(storedFilename);
    const stats = fs.lstatSync(path);
    return stats.isFile() ? { path, size: stats.size } : null;
  } catch {
    return null;
  }
}

/**
 * The rows and the fate of every linked receipt. `stat: true` (the pack itself) looks at each file
 * the viewer may open and reads its real size; `stat: false` (the card's estimate) takes the size
 * recorded in the database and touches no file.
 */
function gather(year: number, viewer: Viewer, stat: boolean): Gathered {
  const rows = taxDetailRows(year, viewer);
  const firstRow = new Map<number, TaxDetailRow>();
  for (const row of rows) if (!firstRow.has(row.txnId)) firstRow.set(row.txnId, row);
  const txnIds = [...firstRow.keys()];
  const order = new Map(txnIds.map((id, index) => [id, index]));

  const links = linkedReceipts(txnIds).sort(
    (a, b) => (order.get(a.txnId) ?? 0) - (order.get(b.txnId) ?? 0) || a.receiptId - b.receiptId,
  );
  const receipts = new Map<number, ReceiptState>();
  const receiptsByTxn = new Map<number, number[]>();
  for (const link of links) {
    const list = receiptsByTxn.get(link.txnId) ?? [];
    if (!list.includes(link.receiptId)) list.push(link.receiptId);
    receiptsByTxn.set(link.txnId, list);
    if (receipts.has(link.receiptId)) continue;

    if (!canActOnOwner(link.ownerUserId, viewer)) {
      receipts.set(link.receiptId, { kind: 'held', ownerUserId: link.ownerUserId });
      continue;
    }
    const row = firstRow.get(link.txnId);
    if (!row || !isReceiptMime(link.mime)) {
      receipts.set(link.receiptId, { kind: 'missing' });
      continue;
    }
    const zipName = `receipts/${row.date}_${nameSafe(row.description)}_r${link.receiptId}.${extForMime(link.mime)}`;
    if (!stat) {
      receipts.set(link.receiptId, { kind: 'included', zipName, date: row.date, size: link.sizeBytes, path: null });
      continue;
    }
    const file = receiptFile(link.storedFilename);
    receipts.set(
      link.receiptId,
      file === null ? { kind: 'missing' } : { kind: 'included', zipName, date: row.date, size: file.size, path: file.path },
    );
  }

  const names = new Map(getDb().select({ id: users.id, name: users.name }).from(users).all().map((user) => [user.id, user.name]));
  return { rows, receipts, receiptsByTxn, names };
}

/** `2.4 GB`, `8.4 MB`, `120 KB`, `25 bytes`: rounded up, one decimal at most. */
export function formatPackBytes(bytes: number): string {
  const units: [string, number][] = [
    ['GB', 1024 ** 3],
    ['MB', 1024 ** 2],
    ['KB', 1024],
  ];
  for (const [unit, size] of units) {
    if (bytes < size) continue;
    const value = Math.ceil((bytes / size) * 10) / 10;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
  }
  return bytes === 1 ? '1 byte' : `${bytes} bytes`;
}

/** B5's refusal, said the same way by the zip route's 413 and by the card. */
export function yearEndTooLargeMessage(receiptCount: number, receiptBytes: number, maxReceiptBytes = YEAR_END_MAX_RECEIPT_BYTES): string {
  const after = 'Download the detail CSV, and the receipts from each item.';
  if (receiptCount > YEAR_END_MAX_RECEIPTS) {
    return `This year has ${receiptCount.toLocaleString('en-US')} receipts, more than the ${YEAR_END_MAX_RECEIPTS.toLocaleString('en-US')} one pack can carry. ${after}`;
  }
  return `This year's receipts come to ${formatPackBytes(receiptBytes)}, more than the ${formatPackBytes(maxReceiptBytes)} one pack can carry. ${after}`;
}

function isTooLarge(receiptCount: number, receiptBytes: number, maxReceiptBytes: number): boolean {
  return receiptBytes > maxReceiptBytes || receiptCount > YEAR_END_MAX_RECEIPTS;
}

type DetailCsvRow = Record<string, unknown>;

const DETAIL_COLUMNS: CsvColumn<DetailCsvRow>[] = [
  'Date',
  'Account',
  'Description',
  'Category',
  'Tax category',
  'Person',
  'Amount',
  'Notes',
  'Receipt files',
  'Receipts not included',
].map((key) => ({ key, header: key }));

/**
 * The detail CSV (B4). Built on reports.ts's toCsv, so a description or note starting with = + - @
 * reaches the sheet as text, the guard every export here shares. `Receipts not included` names the
 * holder for a household viewer (`1 held by Sam`) and nobody for a self viewer (`1 held by someone
 * else`): a self viewer is never given another member's name.
 */
function detailCsv(gathered: Gathered, viewer: Viewer): string {
  const selfScoped = ownerScope(viewer) !== null;
  const holder = (ownerUserId: number) => (selfScoped ? 'someone else' : (gathered.names.get(ownerUserId) ?? 'someone else'));

  const rows: DetailCsvRow[] = gathered.rows.map((row) => {
    const files: string[] = [];
    const held = new Map<string, number>();
    let missing = 0;
    for (const id of gathered.receiptsByTxn.get(row.txnId) ?? []) {
      const state = gathered.receipts.get(id);
      if (!state) continue;
      if (state.kind === 'included') files.push(state.zipName);
      else if (state.kind === 'held') held.set(holder(state.ownerUserId), (held.get(holder(state.ownerUserId)) ?? 0) + 1);
      else missing += 1;
    }
    const notIncluded = [...held].map(([name, count]) => `${count} held by ${name}`);
    if (missing > 0) notIncluded.push(`${missing} missing from this install`);
    return {
      Date: row.date,
      Account: row.accountName,
      Description: row.description,
      Category: row.categoryPath,
      'Tax category': row.taxCategories.join('; '),
      Person: row.personName,
      Amount: (row.amountCents / 100).toFixed(2),
      Notes: row.note ?? '',
      'Receipt files': files.join('; '),
      'Receipts not included': notIncluded.join('; '),
    };
  });
  return toCsv(rows, DETAIL_COLUMNS);
}

/**
 * B5. The detail CSV on its own, exactly the file the pack carries: the same rows, the same receipt
 * names, the same not-included notes.
 */
export function yearEndDetailCsv(year: number, viewer: Viewer): string {
  return detailCsv(gather(year, viewer, true), viewer);
}

export interface YearEndPlan {
  entries: ZipEntry[];
  receiptCount: number;
  receiptBytes: number;
  omitted: { heldByOthers: number; missing: number };
  tooLarge: boolean;
  /** yearEndTooLargeMessage when tooLarge, else null. */
  tooLargeMessage: string | null;
}

function readme(year: number, viewer: Viewer, today: string, names: Map<number, string>): string {
  const own = ownerScope(viewer);
  const whose = own === null ? 'Rows for the whole household.' : `Rows for ${names.get(own) ?? 'you'} only.`;
  const soFar = today.startsWith(`${year}-`) ? ' so far' : '';
  return [
    `Year-end pack for ${year}${soFar}, made ${today}. ${whose}`,
    `tax-detail-${year}.csv lists every transaction, or part of a split, filed in a tax-relevant category, with the receipt files that go with it.`,
    `tax-totals-${year}.csv holds the total for each tax-relevant category and person, as the Reports page shows them.`,
    'receipts/ holds the receipts you can open in the app. Any other receipt is named in the detail CSV under Receipts not included.',
    "A tax-relevant category includes its sub-categories, so when a parent and a sub-category are both marked, the sub-category's spending is in both totals. Do not add the two together.",
  ].join('\r\n') + '\r\n';
}

/**
 * B4. Everything the zip will hold, with every receipt file's real size read now (Y2: the headers
 * carry real sizes and the route an exact content-length). `today` (YYYY-MM-DD, the household's)
 * dates the CSVs and the README in the archive listing; each receipt carries its transaction's date.
 */
export function planYearEndPack(year: number, viewer: Viewer, opts: { today: string; maxReceiptBytes?: number }): YearEndPlan {
  const gathered = gather(year, viewer, true);
  const maxReceiptBytes = opts.maxReceiptBytes ?? YEAR_END_MAX_RECEIPT_BYTES;

  const receiptEntries: ZipEntry[] = [];
  let heldByOthers = 0;
  let missing = 0;
  for (const state of gathered.receipts.values()) {
    if (state.kind === 'held') heldByOthers += 1;
    else if (state.kind === 'missing') missing += 1;
    else if (state.path !== null) receiptEntries.push({ name: state.zipName, date: state.date, size: state.size, source: { path: state.path } });
  }
  const receiptBytes = receiptEntries.reduce((sum, entry) => sum + entry.size, 0);
  const receiptCount = receiptEntries.length;
  const tooLarge = isTooLarge(receiptCount, receiptBytes, maxReceiptBytes);

  const text = (name: string, body: string): ZipEntry => {
    const source = Buffer.from(body, 'utf8');
    return { name, date: opts.today, size: source.length, source };
  };
  return {
    entries: [
      text('README.txt', readme(year, viewer, opts.today, gathered.names)),
      text(`tax-detail-${year}.csv`, detailCsv(gathered, viewer)),
      text(`tax-totals-${year}.csv`, taxYearCsv(year, viewer)),
      ...receiptEntries,
    ],
    receiptCount,
    receiptBytes,
    omitted: { heldByOthers, missing },
    tooLarge,
    tooLargeMessage: tooLarge ? yearEndTooLargeMessage(receiptCount, receiptBytes, maxReceiptBytes) : null,
  };
}

export interface YearEndPackEstimate {
  receiptCount: number;
  receiptBytes: number;
  heldByOthers: number;
  tooLarge: boolean;
  tooLargeMessage: string | null;
}

/**
 * B4. The card's hint: the same rows and the same receipt read as the pack, with the sizes the
 * database recorded at upload and no file touched. Equal to the plan whenever every file is there.
 */
export function yearEndPackEstimate(year: number, viewer: Viewer): YearEndPackEstimate {
  const gathered = gather(year, viewer, false);
  let receiptCount = 0;
  let receiptBytes = 0;
  let heldByOthers = 0;
  for (const state of gathered.receipts.values()) {
    if (state.kind === 'held') heldByOthers += 1;
    if (state.kind !== 'included') continue;
    receiptCount += 1;
    receiptBytes += state.size;
  }
  const tooLarge = isTooLarge(receiptCount, receiptBytes, YEAR_END_MAX_RECEIPT_BYTES);
  return {
    receiptCount,
    receiptBytes,
    heldByOthers,
    tooLarge,
    tooLargeMessage: tooLarge ? yearEndTooLargeMessage(receiptCount, receiptBytes) : null,
  };
}

/** The card's muted line under its two downloads: `Includes 12 receipts, 8.4 MB.`, or the refusal. */
export function yearEndPackLine(estimate: YearEndPackEstimate): string {
  if (estimate.tooLargeMessage !== null) return estimate.tooLargeMessage;
  if (estimate.receiptCount === 0) return 'Includes no receipts.';
  const noun = estimate.receiptCount === 1 ? 'receipt' : 'receipts';
  return `Includes ${estimate.receiptCount} ${noun}, ${formatPackBytes(estimate.receiptBytes)}.`;
}
