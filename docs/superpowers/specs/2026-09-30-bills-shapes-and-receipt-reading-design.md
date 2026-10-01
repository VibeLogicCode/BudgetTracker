# Bills that carry their amount, and a receipt reader that reads

Date: 2026-09-30
Status: implemented in v1.53.0

Two reports from the same household, which turned out to be one problem seen from two sides: a
bill's amount is never asked for and never shown, and the document that would have supplied it —
an e-bill PDF — came back with nothing. This spec records what is actually wrong (measured, not
guessed), what will be built, and what is deliberately left alone.

## 1. What was found

### 1.1 Bills have money, but it is asked for late and shown almost nowhere

A bill is a `warranty_items` row whose type has kind `bill`. Its money lives **only** in
`bill_installments.amount_cents`, one row per due date. The cadence pair and the price are
forbidden for the kind (ruling B4/C4, "the schedule replaces the cadence"), and the create form
therefore collects **no amount at all** for a bill — the only way in is the "Add installment" form
on the detail page, third card down, after saving. A person who saves and goes back to the list has
a bill with no amount anywhere; the detail page reads "$0.00 outstanding, No installments yet".

Even with installments entered, the two places a person looks first show no money: the list row's
Price and Billing cells always render `—` for a bill (the fields they read are forbidden for the
kind), and the detail summary has no bill arm. `page.tsx` already loads every unpaid installment
with its amount to build the row's "Next due" label — and then throws the amount away.

### 1.2 The receipt reader has three measured bugs, and a PDF path that flattens the page

Synthetic receipts (fictional merchant, invented figures) were run through the production
pipeline with the vendored models. The numbers:

| Input | Shipped ONNX path | After the two fixes below |
|---|---|---|
| Clean flat scan | 1.1% CER, total correct | 0% |
| Phone photo, 6° tilt, countertop in frame | **86% CER — no merchant, no date, no total** | 12% CER, every word and number correct; residual is line pairing |
| Long 25-item receipt | 1% CER, merchant duplicated, a digit dropped | 0% |
| Saved sideways (90°, no EXIF) | garbage, both engines | — (needs a page-orientation step, §2.4) |

Root causes, each with a one-line fix:

1. **Box score ignores the polygon.** `boxScoreFast` averages the probability map over the
   axis-aligned bounding box with no mask. RapidOCR/PaddleOCR mask to the polygon. A long text
   line tilted 4–6° has a bounding box that is mostly background, scores under 0.5, and is thrown
   away — 13 of 24 lines on the photo, every long one. Its comment claims parity with RapidOCR; it
   does not have it.
2. **Crop centre is not rotated.** `cropBoxes` rotates the whole image by the box angle, then
   offsets the box centre only by the canvas growth — never rotates it about the image centre. A
   box 400 px from centre at 5° lands 35 px off, more than a text line. At sub-degree tilts this is
   what duplicates boundary fragments ("MAPLE G GROCERY", "VISA A") and drops trailing digits
   ("4.22" → "4.2"). The existing test checks only the crop's size, at the exact image centre.
3. **Deskew treats the countertop as ink.** Otsu over the whole frame; on any non-white background
   the estimate runs to the ±10° search bound and the image is over-rotated. Then (1) removes every
   box and the result is **empty text stored as "done"** — the tile says "Read", nothing is filled,
   nothing says why.

Two things that are not bugs but make the above worse: line assembly groups by axis-aligned
y-overlap, so any residual tilt pairs each price with the line above it; and there is no
0/90/180/270 page-orientation step (the classifier only flips lines 0/180).

Resolution is **not** the bottleneck: raising the 1600 px cap to 3200 changed nothing on the photo
and made it 3.4× slower. The Tesseract fallback, which skips preprocessing entirely, read the same
photo at 4% CER — better than the primary engine — and halved its time when fed the preprocessed
image.

**The PDF path.** Text-layer PDFs never touch OCR, which is right. But every text item on a page is
joined with spaces into **one line**, so the vendor becomes the first 60 characters of the page and
the line-based total and date heuristics have one line to work with. On a bill, the amount that was
found went into a `price` field the bill form never renders. Net effect for a text-layer e-bill:
nothing visible happens.

### 1.3 The extractor guesses, and nobody can see what it read

`suggestPriceCents` falls back to the **largest currency figure anywhere** when no TOTAL line is
found, so a `CASH $100.00` beats a `$47.32` total. There is no due-date extractor at all. The
recognised text is shown nowhere; the poll endpoint returns only three fields, citing a spec item
that deferred *editing* the text, not showing it. A wrong value looks exactly as sure as a right
one. This analysis was reached once before (PENDING-FIXES item G) and dropped; it stands.

## 2. Decisions

### 2.1 Bills: the amount is asked for at creation, and shown where people look

Three shapes exist in real life, and one model serves all three — a bill owns one or more dated
amounts:

| Shape | Example | What the form takes | What the list shows |
|---|---|---|---|
| One payment | a water bill | amount due + due date, on creation | that amount, that date |
| Installment plan | property tax | the first amount + date on creation; the rest on the detail page | next amount; `N unpaid · $X outstanding` |
| Recurring | a phone bill | amount due + due date; each new e-bill attached adds the next | the current one |

So: **the create form offers "Amount due" and "Due date" for a bill**, as an optional pair (both or
neither), and writes the first installment inside the same transaction as the item. Nothing forces
a second step. No new column, no migration: the shape is how the form is used, not something stored.

**Shown:** the list row's Price cell (the phone card's amount slot) carries the next unpaid amount
for a bill; the Billing cell carries `N unpaid · $X outstanding` when more than one is unpaid. The
detail summary gains "Next payment: $X due DATE" and "Outstanding: $Y (N unpaid)". The Installments
card moves above Linked transactions. Ruling P4 (the "Next due" label stays date-only) is kept —
the amount goes in the money cells, which is where money already lives on every other row.

**The reader feeds the bill.** Attaching an e-bill — on creation or on the detail page — suggests
*Amount due* and *Due date* for the bill's next installment, with the form pre-filled and the person
confirming. On the detail page the add-installment form is what gets pre-filled.

### 2.2 PDF: read the text layer as lines, not as a paragraph

Items are grouped into lines by their vertical position (`transform[5]`, with a tolerance of half
the median text height) and ordered left to right, and `hasEOL` ends a line. Pages are capped
(review S-06) so one pathological PDF cannot run forever. **Scanned PDFs stay refused**, with the
existing message: rasterising needs a native canvas backend with its own multi-arch build question,
and the household's e-bills have text layers. Recorded as deferred, not forgotten.

### 2.3 Extraction: never guess, always show

- The "largest number anywhere" fallback is **deleted**. No TOTAL line, no total. A blank field a
  person fills beats a confident wrong one.
- Payment lines are excluded as total candidates (`cash|change|tender|tendered|tip|gratuity|
  approved|payment|cash back`). TOTAL matches fuzzily (`T0TAL`, `IOTAL`, `total due`, `amount
  due`, `balance due`, `montant`, `solde`).
- A **due-date extractor** reads the date on a line that says `due`, `due date`, `payable by`,
  `pay by`, `échéance`; it may be in the future, up to eighteen months out.
- Every amount and date found becomes a **candidate with the words around it**, the same shape the
  loan statement reader already shows as chips. The recognised text is returned to the client as
  lines (capped) and shown under the receipt tile in a collapsible panel. An empty read is a
  **failure with a message** ("No text was found on this image"), never a silent "Read".
- The tile **leads with what was used**: one row for the amount and one for the date, each the
  figure the page filled or the chip last tapped on that tile, with its value and the words beside
  it, the figure cut out ("Amount due"), on one truncated line. The date row reads *Due* where the
  date chips fill a bill's due date and *Date* otherwise, and a bill's start date is never shown as
  its due date. Every other figure folds under **Other figures (N)**: value-only chips in an
  *Amounts* and a *Dates* row, one per value, the one in use checked and pressed, the words in each
  chip's name and title. *What was read* comes after it. A page with no handler for a field shows
  neither for that field.
- Suggestions route to the field the kind actually has: a bill's amount goes to *Amount due*, a
  subscription's or loan's to its billing/payment amount, a warranty's to *Price*.

### 2.4 Image path: fix what was measured, then make the rest honest

In order of measured value:

1. Polygon-masked box score (parity with RapidOCR, which the comment already claims).
2. Crop centre rotated about the image centre; the test checks the crop's **content**, not its size.
3. Deskew refuses to guess when the binarised frame is mostly "ink" (a dark background), returning
   0° instead of the search bound.
4. Tilt-aware line assembly: box centres are rotated by the median text angle before grouping, so
   a residual tilt no longer pairs a price with the wrong line.
5. Page orientation: the real detection pass runs on the upright image first, and only when its
   boxes look sideways (wide boxes no more numerous than tall ones) is detection run once more on
   the full-size image turned 90°; the turn with more wide boxes wins, and no third detection is
   run. A page that lands upside down is told from the line classifier's own votes (a strict
   majority of lines flipped 180°), and its box positions are turned 180° before line assembly.
   No new model.
6. The Tesseract fallback receives the preprocessed image (measured: fixes the date, halves the
   time).
7. An accuracy harness: synthetic receipts rendered in-test through the real vendored models,
   asserting CER bounds and that merchant, date and TOTAL are extracted — flat, tilted on a
   background, long, and sideways. The pipeline has had no recognition-quality test at all; the
   fake sessions in the integration test return "SPATULA" for everything, which is how bugs 1 and 2
   passed the whole suite.

Not done, with reasons: raising the resolution cap (measured no gain, 3.4× cost); a bigger or
different model (the problem was never the model); any cloud or keyed service (the household's
constraint: local or free, no linked accounts — and the app's zero-egress promise).

### 2.5 Capture and feedback

- The browser crop's "quad must cover 25% of the frame" rule rejected exactly the long receipt it
  exists for. It becomes a floor of 8% with a ceiling of 97% (the ceiling is what the comment
  actually meant).
- A second, plain file input beside the camera one, so a PDF or an existing photo can be picked on
  a phone. Each input is visually hidden inside a secondary-button label: "Take a photo" (the camera
  input, which keeps `capture="environment"`, MUST-6.1) and "Choose a file". A desktop ignores
  `capture`, so the camera button shows only on a coarse pointer, by CSS alone
  (`@media (pointer: coarse)`), and the server and the browser render the same markup.
- The scan preview grows (max-h-64), the auto-accept countdown goes from 4 s to 8 s, and a scanner
  fallback **says so** ("Couldn't find the paper edges — using the whole photo") instead of
  uploading in silence.
- Copy: the Add page stops promising that price fills itself in for a kind that has no price; the
  privacy sentence becomes "nothing leaves your network" (from a phone the photo *is* uploaded — to
  your own server).

## 3. Where the parts live

| Concern | Location |
| --- | --- |
| Bill create fields + first installment | `src/app/(app)/warranties/new/new-warranty-client.tsx`, `src/app/(app)/warranties/actions.ts` (`createWarrantyAction`), `src/lib/warranty/items.ts` (`createWarrantyItem` option) |
| Bill amount on list/detail | `src/app/(app)/warranties/page.tsx` (`billSchedules`), `warranties-client.tsx`, `[id]/warranty-detail-client.tsx` |
| PDF lines | `src/lib/warranty/ocr/pdf.ts` |
| Extraction | `src/lib/warranty/suggest.ts` (`suggestDueDate`, candidates, `candidateLabel`, fuzzy total, no fallback) |
| Reader output to client | `src/lib/warranty/ocr/queue.ts` (sidecar `lines`, `candidates`), `src/app/api/warranties/receipts/stage/[stagingId]/route.ts` |
| Client feedback | `src/components/warranty/ReceiptUploader.tsx`, `ReceiptScanPreview.tsx`, `src/lib/scanner/scan.ts` |
| Engine fixes | `src/lib/warranty/ocr/onnx/{contours,crop,preprocess,assemble,engine,orientation}.ts`, `src/lib/warranty/ocr/tesseract.ts`, `src/lib/warranty/ocr/onnx/constants.ts` |
| Accuracy harness | `tests/helpers/ocr-receipts.ts` (new), `tests/integration/ocr-accuracy.test.ts` (new) |

## 4. Out of scope

Scanned-PDF rasterisation (§2.2); editing an installment in place (ruling B8 stands); any change to
payment matching; a document-orientation model; HEIC; a cloud or keyed OCR of any kind.

## 5. Release

v1.53.0. New form fields and new reader behaviour are user-visible; no migration.
