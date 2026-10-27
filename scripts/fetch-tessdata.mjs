#!/usr/bin/env node
/**
 * ONE-TIME regeneration helper for vendor/tessdata/eng.traineddata.gz (MUST-7.7).
 *
 * Run by a maintainer with internet access. It is NEVER invoked by a build, by a test,
 * or by the app: the .gz is committed to the repository precisely so that an offline LAN
 * install has no dependency on npm resolution or on a third-party data package staying
 * published (§17.21).
 *
 *   node scripts/fetch-tessdata.mjs
 *
 * It prints the sha256 of the file it wrote and exits non-zero when that differs from
 * TESSDATA_SHA256 in src/lib/warranty/ocr/assets.ts (also pinned in scripts/check-ocr-assets.mjs),
 * so a corrupt or swapped file is caught by CI rather than at a family member's first upload.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

// v1.58.1: the expected digest is read from the one constant the app and the build guard use.
const ASSETS_SOURCE = path.join(process.cwd(), 'src', 'lib', 'warranty', 'ocr', 'assets.ts');
const expectedMatch = /export const TESSDATA_SHA256 = '([0-9a-f]{64})'/.exec(fs.readFileSync(ASSETS_SOURCE, 'utf8'));
if (expectedMatch === null) {
  console.error('Could not read TESSDATA_SHA256 from src/lib/warranty/ocr/assets.ts. Run this from the repository root.');
  process.exit(1);
}
const EXPECTED_SHA256 = expectedMatch[1];

// v1.58.1: a specific upstream commit rather than the moving main branch, so the download is the
// same bytes every time. Moving the pin means choosing a new commit and updating TESSDATA_SHA256.
const TESSDATA_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd';
const URL_ENG = `https://github.com/tesseract-ocr/tessdata_fast/raw/${TESSDATA_COMMIT}/eng.traineddata`;
const OUT_DIR = path.join(process.cwd(), 'vendor', 'tessdata');
const OUT_FILE = path.join(OUT_DIR, 'eng.traineddata.gz');

const response = await fetch(URL_ENG);
if (!response.ok) {
  console.error(`Download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}
const raw = Buffer.from(await response.arrayBuffer());
if (raw.length < 1_000_000) {
  console.error(`Refusing a suspiciously small download (${raw.length} bytes)`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT_FILE, gz);

const digest = createHash('sha256').update(gz).digest('hex');
console.log(`wrote ${OUT_FILE} (${gz.length} bytes)`);
console.log(`eng.traineddata.gz sha256 = ${digest}`);
if (digest !== EXPECTED_SHA256) {
  console.error(`MISMATCH: expected ${EXPECTED_SHA256} (TESSDATA_SHA256 in src/lib/warranty/ocr/assets.ts).`);
  console.error(
    'If the pinned commit was changed on purpose, update TESSDATA_SHA256 in src/lib/warranty/ocr/assets.ts ' +
      'and in scripts/check-ocr-assets.mjs to the value printed above, then re-run the tests. ' +
      'Otherwise discard this file: it is not the data the build verifies.',
  );
  process.exit(1);
}
console.log('Matches TESSDATA_SHA256.');
