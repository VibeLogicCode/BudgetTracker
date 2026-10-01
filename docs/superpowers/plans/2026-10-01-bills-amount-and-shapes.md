# Bills carry their amount — Implementation Plan (Part A of v1.53.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bill asks for its amount and due date when it is created, writes them as its first installment in the same transaction, and shows the next amount and what is outstanding on the Loans & Coverage list row and the bill's own page — so no household member creates a bill, goes back to the list, and finds it has no money anywhere.

**Architecture:** No new column and no migration. The bill's money stays where it already lives, `bill_installments.amount_cents`; what changes is when it is collected (on creation, as an optional amount + due date pair) and where it is rendered (the list row's two money cells and the detail summary, fed by the installment rows the pages already load). The three real-life shapes — one payment, an installment plan, a recurring bill — are how the form is used, not something stored. Part B (`2026-10-01-receipt-reading.md`) makes an attached e-bill pre-fill these same fields; this plan leaves the hooks it needs (`onSuggestions` on the detail page, a controlled add-installment form) in place.

**Tech Stack:** Next.js 16 App Router, React 19, server actions (`useActionState`), Drizzle over better-sqlite3, zod, Vitest + Testing Library (jsdom, no jest-dom).

**Spec:** `docs/superpowers/specs/2026-09-30-bills-shapes-and-receipt-reading-design.md` §1.1 and §2.1. Every task below cites its section.

## Global Constraints

- **Public repo.** No owner name, employer, Windows paths, real bill figures, account numbers or verbatim owner quotes anywhere. Fixtures use a fictional utility ("Riverside Water") and invented amounts.
- **Commit messages:** subject + a few bullets. **No `Co-Authored-By` or AI attribution lines** (repo rule overrides the harness default). Author is the repo's configured git user.
- **TDD, one file at a time:** `npx vitest run <file>`. The known full-run flake is `tests/ops/install.test.ts` (or occasionally `tests/lib/update/*`) with `Timeout calling "onTaskUpdate"`: rerun that file alone.
- **Bash heredocs break on backticks and `\n`/`\b` escapes here.** Patch with the Edit tool, or write a python script to the scratchpad with the Write tool and run it.
- **Ruling P4 stands:** `billScheduleLabel` stays dates-and-counts only; `tests/lib/warranty/constants.test.ts:406-408` pins it. The amount goes in the money cells, not in that label.
- **Ruling B7 stands:** gates decide what a form OFFERS, never what it may HIDE. `installmentsAllowedForKind(kind)` gates the new fields and the first-installment write.
- **Kind wording lives in `src/lib/warranty/constants.ts` only** (MUST-19.11). New user-visible labels are added there, not inline.
- **`tests/app/warranties-actions.test.ts` pins the set of exported actions** against its origin-check table (`'the fixture map above covers exactly the module's exported actions'`). This plan adds no action, so nothing changes there.
- **Copy is copied verbatim** from the task that names it.
- **Release is Part B's last task** (`chore(release): v1.53.0`); this plan ends with Task 5's commit and no version bump.

## Review Focus

Inputs the spec implies but no task's first test exercises; each line names the task whose tests pin it.

1. **One field filled, the other blank** on the create form (amount without date, or date without amount) must be refused with one sentence, not written as a half-installment or silently dropped. Task 1 (`'refuses half a pair'`).
2. **A negative or signed amount** (`-312.44`) is the size of the bill, as `addInstallmentAction` already treats it. Task 1 (`'stores the magnitude'`).
3. **A non-bill kind that somehow posts the fields** (a stale form, a hand-made post) must create no installment and must not fail the item save. Task 1 (`'ignores the pair for a kind that has no installments'`).
4. **A bill whose installments are all paid** must show no stale "next" amount on the list — the Price cell returns to `—` and the Expiry cell to the open-ended word, which `billScheduleLabel` already does. Task 3 (`'shows nothing when every installment is paid'`).
5. **A self-scoped member's list** must not carry another member's bill amounts; the fold already runs under `ownerUserId: scope`, and the test proves the amounts ride the same scoping. Task 3 (`'scopes the amounts the way it already scopes the dates'`).

---

## File map

| Area | Files |
|---|---|
| Lib | `src/lib/warranty/items.ts` (`createWarrantyItem` gains `options.firstInstallment`), `src/lib/warranty/constants.ts` (bill amount wording) |
| Action | `src/app/(app)/warranties/actions.ts` (`createWarrantyAction` reads `dueDate` + `amountDue`) |
| Create form | `src/app/(app)/warranties/new/new-warranty-client.tsx` |
| List | `src/app/(app)/warranties/page.tsx` (`billSchedules` carries amounts), `src/app/(app)/warranties/warranties-client.tsx` (money cells) |
| Detail | `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` (summary rows, card order, controlled add-installment form) |
| Tests | `tests/app/warranties-actions.test.ts`, `tests/app/new-warranty-client.test.tsx`, `tests/app/warranties-client.test.tsx`, `tests/app/warranty-detail-client.test.tsx`, `tests/lib/warranty/constants.test.ts`, `tests/lib/warranty/items.test.ts` (or the file that already tests `createWarrantyItem`; find it with `grep -rln "createWarrantyItem(" tests/lib`) |

---

### Task 1: The first installment is written with the item

**Files:**
- Modify: `src/lib/warranty/items.ts:549-633` (`createWarrantyItem`), plus its `@/db/schema` import
- Modify: `src/lib/warranty/constants.ts` (one new error string)
- Modify: `src/app/(app)/warranties/actions.ts:427-452` (`createWarrantyAction`)
- Test: the file that already exercises `createWarrantyItem` under `tests/lib/warranty/` (find with `grep -rln "createWarrantyItem(" tests/lib`), and `tests/app/warranties-actions.test.ts`

**Interfaces:**
- Produces: `createWarrantyItem(input, staged?, at?, claimedBy?, options?: { firstInstallment?: { dueDate: string; amountCents: number } })`. The installment is inserted **inside** the item's own `db.transaction`, after `commitStaged`. If `installmentsAllowedForKind(kind of input.typeId)` is false the option throws `INSTALLMENT_KIND_ERROR` before the transaction opens.
- Produces: `BILL_PAIR_ERROR = 'Enter both the amount due and the due date, or leave both blank.'` in constants.ts.
- Produces: `createWarrantyAction` reads form fields `dueDate` and `amountDue`; both blank means no installment.

- [ ] **Step 1: Write the failing lib test**

Open the existing `createWarrantyItem` test file under `tests/lib/warranty/`. Note how it seeds a type with `kind: 'bill'` (if no bill type exists there, create one with `createItemType({ name: 'Bill', kind: 'bill' })` from `@/lib/warranty/types`, the same way `tests/app/warranty-installments.test.ts` does). Append:

```ts
/** Spec 2026-09-30 §2.1: the amount is asked for when the bill is created, not on a second visit. */
describe('createWarrantyItem: the first installment rides the same transaction', () => {
  it('writes one unpaid installment with the amount and due date given', () => {
    const { db, ownerId, billTypeId } = setup(); // adapt to this file's own setup helper
    const id = createWarrantyItem(
      { ...baseInput(), name: 'Riverside Water', typeId: billTypeId, ownerUserId: ownerId },
      [],
      undefined,
      undefined,
      { firstInstallment: { dueDate: '2026-11-24', amountCents: 31244 } },
    );
    const rows = db.all<{ due_date: string; amount_cents: number; paid_at: string | null }>(
      sql`select due_date, amount_cents, paid_at from bill_installments where item_id = ${id}`,
    );
    expect(rows).toEqual([{ due_date: '2026-11-24', amount_cents: 31244, paid_at: null }]);
  });

  it('writes none when the option is absent -- an installment plan is entered on the detail page', () => {
    const { db, ownerId, billTypeId } = setup();
    const id = createWarrantyItem({ ...baseInput(), name: 'Property tax', typeId: billTypeId, ownerUserId: ownerId });
    expect(db.get<{ n: number }>(sql`select count(*) as n from bill_installments where item_id = ${id}`).n).toBe(0);
  });

  /** Review focus 3. */
  it('refuses the option for a kind that has no installments, and writes nothing at all', () => {
    const { db, ownerId, warrantyTypeId } = setup();
    const before = db.get<{ n: number }>(sql`select count(*) as n from warranty_items`).n;
    expect(() =>
      createWarrantyItem(
        { ...baseInput(), name: 'Fridge', typeId: warrantyTypeId, ownerUserId: ownerId },
        [],
        undefined,
        undefined,
        { firstInstallment: { dueDate: '2026-10-31', amountCents: 100 } },
      ),
    ).toThrow(INSTALLMENT_KIND_ERROR);
    expect(db.get<{ n: number }>(sql`select count(*) as n from warranty_items`).n).toBe(before);
  });
});
```

`baseInput()` is whatever minimal `WarrantyInput` builder that file already uses; `INSTALLMENT_KIND_ERROR` is imported from `@/lib/warranty/constants`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run <that file>`
Expected: TypeScript-level failure at load (`createWarrantyItem` takes 4 arguments) or, under esbuild, the first test fails with `[]` instead of one row.

- [ ] **Step 3: Implement the option**

In `src/lib/warranty/items.ts`, add `billInstallments` to the `@/db/schema` import. Change the signature:

```ts
export function createWarrantyItem(
  input: WarrantyInput,
  staged: StagedReceiptRef[] = [],
  at: string = nowIso(),
  claimedBy?: number,
  options: {
    /**
     * Spec 2026-09-30 §2.1. A bill's first dated amount, written INSIDE the item's own transaction
     * so there is never a saved bill with no money and no second step to go back for. Absent for
     * every other kind, and for a bill whose schedule will be entered on the detail page.
     */
    firstInstallment?: { dueDate: string; amountCents: number };
  } = {},
): number {
```

Immediately after the existing `assertInterestBasisIsUsable(...)` line, add:

```ts
  // Checked BEFORE the transaction, like every other kind assertion above: a mismatch writes nothing.
  if (options.firstInstallment !== undefined && !installmentsAllowedForKind(kindOfType(input.typeId))) {
    throw new Error(INSTALLMENT_KIND_ERROR);
  }
```

`kindOfType` is whatever helper `assertBillingMatchesKind` (same file, ~line 392) uses to resolve a type id to its kind — reuse that exact function; do not add a second lookup. Import `installmentsAllowedForKind` and `INSTALLMENT_KIND_ERROR` from `@/lib/warranty/constants` if not already imported.

Inside the `db.transaction((tx) => { ... })` callback, after `commitStaged(tx, row.id, staged, at, adopted, deferred, claimedBy);` and before `return row.id;`, add:

```ts
      if (options.firstInstallment !== undefined) {
        // The same row addInstallment writes (src/lib/warranty/installments.ts), in the same
        // transaction as the item, so a failure here rolls the item back too.
        tx.insert(billInstallments)
          .values({
            itemId: row.id,
            dueDate: options.firstInstallment.dueDate,
            amountCents: options.firstInstallment.amountCents,
            paidAt: null,
            paidTxnId: null,
            createdAt: at,
          })
          .run();
      }
```

- [ ] **Step 4: Run the lib test to verify it passes**

Run: `npx vitest run <that file>` — expected PASS.

- [ ] **Step 5: Write the failing action tests**

In `tests/app/warranties-actions.test.ts`, inside `describe('createWarrantyAction', …)`, append (adapt `billType` to however that file seeds a bill type; `baseFields` is its existing form builder):

```ts
  /** Spec 2026-09-30 §2.1: amount due and due date ride the create form for a bill. */
  it('creates a bill with its first installment when amount due and due date are given', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ typeId: String(billType.id), amountDue: '312.44', dueDate: '2026-11-24' }))),
    );
    const id = Number(to.split('/').pop());
    const rows = current!.db.all<{ due_date: string; amount_cents: number }>(
      sql`select due_date, amount_cents from bill_installments where item_id = ${id}`,
    );
    expect(rows).toEqual([{ due_date: '2026-11-24', amount_cents: 31244 }]);
  });

  /** Review focus 2. */
  it('stores the magnitude of a signed amount due', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ typeId: String(billType.id), amountDue: '-312.44', dueDate: '2026-11-24' }))),
    );
    const id = Number(to.split('/').pop());
    expect(current!.db.get<{ a: number }>(sql`select amount_cents as a from bill_installments where item_id = ${id}`).a).toBe(31244);
  });

  /** Review focus 1. */
  it('refuses half a pair with one sentence, and saves nothing', async () => {
    const before = current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c;
    const result = await createWarrantyAction({}, formData(baseFields({ typeId: String(billType.id), amountDue: '312.44', dueDate: '' })));
    expect(result.error).toBe('Enter both the amount due and the due date, or leave both blank.');
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(before);
  });

  it('creates a bill with no installment when both are blank -- the schedule comes later', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields({ typeId: String(billType.id) }))));
    const id = Number(to.split('/').pop());
    expect(current!.db.get<{ n: number }>(sql`select count(*) as n from bill_installments where item_id = ${id}`).n).toBe(0);
  });

  /** Review focus 3. */
  it('ignores the pair for a kind that has no installments', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields({ amountDue: '12.00', dueDate: '2026-10-31' }))));
    const id = Number(to.split('/').pop());
    expect(current!.db.get<{ n: number }>(sql`select count(*) as n from bill_installments where item_id = ${id}`).n).toBe(0);
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run tests/app/warranties-actions.test.ts`
Expected: the first two new tests FAIL (no installment row), the half-pair test FAILS (no error returned), the last two pass already.

- [ ] **Step 7: Implement the action**

In `src/lib/warranty/constants.ts`, beside `INSTALLMENT_KIND_ERROR`, add:

```ts
/** Spec 2026-09-30 §2.1. The create form's optional pair for a bill: both, or neither. */
export const BILL_PAIR_ERROR = 'Enter both the amount due and the due date, or leave both blank.';
```

In `src/app/(app)/warranties/actions.ts`, add a module-private reader beside `readStaged`:

```ts
/**
 * Spec 2026-09-30 §2.1. A bill's first amount and due date, as an optional PAIR: both present
 * writes the first installment, both blank writes none, one of each is refused. Read for every
 * kind and applied only where installments are allowed (createWarrantyItem refuses otherwise), so
 * a stale form posting the fields for a warranty saves the warranty and ignores the pair.
 */
function readFirstInstallment(formData: FormData): { dueDate: string; amountCents: number } | null | 'half' {
  const dueDate = str(formData, 'dueDate').trim();
  const rawAmount = str(formData, 'amountDue').trim();
  if (dueDate === '' && rawAmount === '') return null;
  if (dueDate === '' || rawAmount === '') return 'half';
  const cents = parseAmountToCents(rawAmount);
  if (cents === null) return 'half';
  // Magnitude, as addInstallmentAction does: a person typing -312.44 means the size of the bill.
  return { dueDate, amountCents: Math.abs(cents) };
}
```

In `createWarrantyAction`, replace the `try` body's first lines:

```ts
    const staged = readStaged(formData);
    const parsed = readItemInput(formData, user.id);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Could not save that item.' };
    if (!typeExistsOrNull(parsed.data.typeId)) return { error: ITEM_TYPE_MISSING_ERROR };
    const first = readFirstInstallment(formData);
    if (first === 'half') return { error: BILL_PAIR_ERROR };
    const kind = parsed.data.typeId === null ? 'warranty' : kindOfType(parsed.data.typeId);
    itemId = createWarrantyItem(
      parsed.data,
      staged,
      undefined,
      user.id,
      first !== null && installmentsAllowedForKind(kind) ? { firstInstallment: first } : {},
    );
```

`kindOfType` here is the same type→kind resolver items.ts uses (export it from items.ts if it is not already exported, or use the existing `typeKind`-style helper actions.ts already imports for `addInstallmentAction`'s `item.kind` path — look at what `readItemInput`/`typeExistsOrNull` import from `@/lib/warranty/types`; `listItemTypes().find((t) => t.id === typeId)?.kind ?? 'warranty'` is acceptable if nothing cleaner is exported). Import `BILL_PAIR_ERROR` and `installmentsAllowedForKind` from `@/lib/warranty/constants`.

- [ ] **Step 8: Run the action tests, typecheck, commit**

Run: `npx vitest run tests/app/warranties-actions.test.ts` — expected PASS, including the exported-actions pin (no new export).
Run: `npx tsc --noEmit` — expected clean.

```bash
git add src/lib/warranty/items.ts src/lib/warranty/constants.ts "src/app/(app)/warranties/actions.ts" tests/lib/warranty tests/app/warranties-actions.test.ts
git commit -m "feat(bills): a bill's first installment is written with the item

- createWarrantyItem takes an optional firstInstallment, inside its own
  transaction; refused for a kind without installments
- createWarrantyAction reads amountDue + dueDate as a pair: both or neither"
```

---

### Task 2: The create form asks for the amount

**Files:**
- Modify: `src/app/(app)/warranties/new/new-warranty-client.tsx` (state at `:96-113`, `onSuggestions` at `:136-152`, the fields after the Billing block at `:387-413`, the header copy at `:217`)
- Modify: `src/lib/warranty/constants.ts` (two labels)
- Test: `tests/app/new-warranty-client.test.tsx`

**Interfaces:**
- Produces: inputs `name="amountDue"` and `name="dueDate"` rendered only when `installmentsAllowedForKind(selectedKind)`; constants `BILL_AMOUNT_DUE_LABEL = 'Amount due'`, `BILL_DUE_DATE_LABEL = 'Due date'`.
- Produces: `onSuggestions` routes `priceCents` to `amountDue` for a bill, to `billingAmount` for subscription/contract/loan, to `price` for warranty; routes `dueDate` (Part B adds it to the DTO; until then the field is optional and unused) to `dueDate` for a bill.
- Produces: the stale-closure bug on `balanceDateTouched` is fixed (read through a ref).

- [ ] **Step 1: Write the failing tests**

In `tests/app/new-warranty-client.test.tsx`, add a bill type to `types`: `{ id: 4, name: 'Bill', kind: 'bill' as const }`. Append:

```ts
/** Spec 2026-09-30 §2.1: the amount is asked for on creation, for the one kind whose money lives in a schedule. */
describe('a bill asks for its amount and due date', () => {
  it('shows Amount due and Due date for a bill, and for no other kind', () => {
    const { container } = renderForm();
    const pick = (id: string) => fireEvent.change(container.querySelector('[name="typeId"]')!, { target: { value: id } });

    pick('4');
    expect(container.querySelector('input[name="amountDue"]')).toBeTruthy();
    expect((container.querySelector('input[name="dueDate"]') as HTMLInputElement).type).toBe('date');
    // A bill has no cadence pair and no price (rulings B4/C4): those stay hidden.
    expect(container.querySelector('input[name="billingAmount"]')).toBeNull();
    expect(container.querySelector('input[name="price"]')).toBeNull();

    pick('2'); // subscription
    expect(container.querySelector('input[name="amountDue"]')).toBeNull();
    pick('1'); // warranty
    expect(container.querySelector('input[name="amountDue"]')).toBeNull();
  });

  it('clears the pair when the type changes away from bill, so a stale value cannot post', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="typeId"]')!, { target: { value: '4' } });
    fireEvent.change(container.querySelector('input[name="amountDue"]')!, { target: { value: '312.44' } });
    fireEvent.change(container.querySelector('[name="typeId"]')!, { target: { value: '1' } });
    fireEvent.change(container.querySelector('[name="typeId"]')!, { target: { value: '4' } });
    expect((container.querySelector('input[name="amountDue"]') as HTMLInputElement).value).toBe('');
  });

  it('says what a bill form is for, not that a price fills itself in', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="typeId"]')!, { target: { value: '4' } });
    expect(container.textContent).toContain('Attach the bill first and the amount due and due date fill themselves in.');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/app/new-warranty-client.test.tsx`
Expected: the three new tests FAIL — no `amountDue` input exists.

- [ ] **Step 3: Implement**

In `src/lib/warranty/constants.ts`, beside `INSTALLMENT_SECTION_LABEL`:

```ts
/** Spec 2026-09-30 §2.1. The create form's pair for a bill, and the detail page's add-installment form. */
export const BILL_AMOUNT_DUE_LABEL = 'Amount due';
export const BILL_DUE_DATE_LABEL = 'Due date';
```

In `new-warranty-client.tsx`:

1. Import `BILL_AMOUNT_DUE_LABEL`, `BILL_DUE_DATE_LABEL`, `installmentsAllowedForKind` from `@/lib/warranty/constants`.
2. After `const [billingAmount, setBillingAmount] = useState('');` add:

```ts
  // Spec 2026-09-30 §2.1. A bill's first amount and due date. Cleared when the kind moves away
  // from bill, like the billing pair above, so a stale value never posts beside a kind that has
  // no installments (createWarrantyItem would refuse it anyway; the form should not ask it to).
  const [amountDue, setAmountDue] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [billTouched, setBillTouched] = useState({ amountDue: false, dueDate: false });
  const installmentsApplicable = installmentsAllowedForKind(selectedKind);
  useEffect(() => {
    if (!installmentsApplicable) {
      setAmountDue('');
      setDueDate('');
      setBillTouched({ amountDue: false, dueDate: false });
    }
  }, [installmentsApplicable]);
```

(Place it after `selectedKind` is computed; `selectedKind` is declared before `billingApplicable`, so put this block right after the `billingApplicable` effect.)

3. Fix the stale closure and route the price by kind. Replace `onSuggestions`:

```ts
  // The balance-date flag is read through a ref for the same reason `touched` is (IMPORTANT 6
  // above): this callback has empty deps and used to see the first render's `false` for ever,
  // so an OCR date overwrote a balance date a person had set by hand.
  const balanceDateTouchedRef = useRef(balanceDateTouched);
  useEffect(() => {
    balanceDateTouchedRef.current = balanceDateTouched;
  }, [balanceDateTouched]);
  const kindRef = useRef(selectedKind);
  useEffect(() => {
    kindRef.current = selectedKind;
  }, [selectedKind]);
  const billTouchedRef = useRef(billTouched);
  useEffect(() => {
    billTouchedRef.current = billTouched;
  }, [billTouched]);

  /** MUST-10.3: only EMPTY, untouched fields are filled from a suggestion. */
  const onSuggestions = useCallback((fields: SuggestedFieldsDto) => {
    const current = touchedRef.current;
    const kind = kindRef.current;
    if (fields.purchaseDate && !current.purchaseDate) {
      setPurchaseDate(fields.purchaseDate);
      if (!balanceDateTouchedRef.current) setBalanceAsOfDate(fields.purchaseDate);
      setSuggested((s) => ({ ...s, purchaseDate: true }));
    }
    if (fields.vendor && !current.vendor) {
      setVendor(fields.vendor);
      setSuggested((s) => ({ ...s, vendor: true }));
    }
    /*
      Spec 2026-09-30 §2.3: the amount goes to the field the KIND actually has. It used to go to
      `price` unconditionally -- an input the form never renders for a bill -- so a bill's amount
      due was found and then thrown away.
    */
    if (fields.priceCents !== undefined) {
      if (installmentsAllowedForKind(kind)) {
        if (!billTouchedRef.current.amountDue) {
          setAmountDue(centsToInput(fields.priceCents));
          setSuggested((s) => ({ ...s, amountDue: true }));
        }
      } else if (billingAllowedForKind(kind)) {
        setBillingAmount((value) => (value === '' ? centsToInput(fields.priceCents!) : value));
      } else if (!current.price) {
        setPrice(centsToInput(fields.priceCents));
        setSuggested((s) => ({ ...s, price: true }));
      }
    }
    if (fields.dueDate && installmentsAllowedForKind(kind) && !billTouchedRef.current.dueDate) {
      setDueDate(fields.dueDate);
      setSuggested((s) => ({ ...s, dueDate: true }));
    }
  }, []);
```

Widen the `suggested` state's initial object to `{ purchaseDate: false, vendor: false, price: false, amountDue: false, dueDate: false }`. `SuggestedFieldsDto` gains `dueDate?: string` (in `ReceiptUploader.tsx` — Part B fills it; adding the optional field now is harmless).

4. Render the pair. Immediately after the `{billingApplicable ? ( … ) : null}` block, add:

```tsx
              {/* Spec 2026-09-30 §2.1. Both or neither: the action refuses half a pair with
                  BILL_PAIR_ERROR. A plan with several dates adds the rest on the detail page. */}
              {installmentsApplicable ? (
                <>
                  <Field
                    label={BILL_AMOUNT_DUE_LABEL}
                    htmlFor="bill-amount-due"
                    hint={suggestedNote(suggested.amountDue, () => {
                      setAmountDue('');
                      setSuggested((s) => ({ ...s, amountDue: false }));
                    })}
                  >
                    <input
                      id="bill-amount-due"
                      name="amountDue"
                      inputMode="decimal"
                      placeholder="e.g. 312.44"
                      value={amountDue}
                      onChange={(e) => {
                        setAmountDue(e.target.value);
                        setBillTouched((t) => ({ ...t, amountDue: true }));
                      }}
                      className={inputClass}
                    />
                  </Field>
                  <Field
                    label={BILL_DUE_DATE_LABEL}
                    htmlFor="bill-due-date"
                    hint={suggestedNote(suggested.dueDate, () => {
                      setDueDate('');
                      setSuggested((s) => ({ ...s, dueDate: false }));
                    })}
                  >
                    <input
                      id="bill-due-date"
                      type="date"
                      name="dueDate"
                      value={dueDate}
                      onChange={(e) => {
                        setDueDate(e.target.value);
                        setBillTouched((t) => ({ ...t, dueDate: true }));
                      }}
                      className={inputClass}
                    />
                  </Field>
                </>
              ) : null}
```

5. The header copy. Replace the literal `description="Attach the receipt first and the date, vendor and price fill themselves in."` with:

```tsx
        description={
          installmentsApplicable
            ? 'Attach the bill first and the amount due and due date fill themselves in.'
            : 'Attach the receipt first and the date, vendor and price fill themselves in.'
        }
```

- [ ] **Step 4: Run the form tests, typecheck, commit**

Run: `npx vitest run tests/app/new-warranty-client.test.tsx` — expected PASS.
Run: `npx tsc --noEmit` — expected clean.

```bash
git add "src/app/(app)/warranties/new/new-warranty-client.tsx" src/lib/warranty/constants.ts src/components/warranty/ReceiptUploader.tsx tests/app/new-warranty-client.test.tsx
git commit -m "feat(bills): the create form asks for amount due and due date

- shown for the bill kind only, cleared when the kind changes
- a receipt's amount goes to the field the kind actually has
- the balance-date flag is read through a ref, not a stale closure"
```

---

### Task 3: The list row shows the next amount and what is outstanding

**Files:**
- Modify: `src/app/(app)/warranties/page.tsx:67-80` (the `billSchedules` fold)
- Modify: `src/app/(app)/warranties/warranties-client.tsx:104` (prop type), `:429-443` (Price and Billing cells)
- Modify: `src/lib/warranty/constants.ts` (one wording helper)
- Test: `tests/app/warranties-client.test.tsx`, `tests/lib/warranty/constants.test.ts`

**Interfaces:**
- Produces: `billSchedules: Record<number, { nextDueDate: string; overdueCount: number; nextAmountCents: number; unpaidCount: number; outstandingCents: number }>` — built from the same `unpaidInstallments()` rows the fold already iterates (first row per item is the next due, because the read orders by `due_date, id`).
- Produces: `billOutstandingLabel(unpaidCount: number, outstandingCents: number): string | null` in constants.ts — `null` when `unpaidCount <= 1`, else `` `${unpaidCount} unpaid · ${formatCents(outstandingCents)} outstanding` ``.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/warranty/constants.test.ts`, after the `billScheduleLabel` describe:

```ts
describe('billOutstandingLabel (spec 2026-09-30 §2.1)', () => {
  it('says nothing for a single unpaid installment -- the Price cell already shows it', () => {
    expect(billOutstandingLabel(1, 31244)).toBeNull();
    expect(billOutstandingLabel(0, 0)).toBeNull();
  });

  it('counts and totals when more than one is unpaid', () => {
    expect(billOutstandingLabel(4, 124976)).toBe('4 unpaid · $1,249.76 outstanding');
  });
});
```

In `tests/app/warranties-client.test.tsx`, the `renderList` default `billSchedules={{}}` is fine. Append:

```ts
/** Spec 2026-09-30 §2.1: a bill's money on the list row, in the money cells, with ruling P4 untouched. */
describe('a bill row shows its money', () => {
  const schedule = { 42: { nextDueDate: '2026-11-24', overdueCount: 0, nextAmountCents: 31244, unpaidCount: 1, outstandingCents: 31244 } };

  it('puts the next amount in the Price cell', () => {
    renderList(result([bill()]), { billSchedules: schedule });
    const priceCell = screen.getByText('312.44').closest('td')!;
    expect(priceCell.getAttribute('data-label')).toBe('Price');
    // Ruling P4: the schedule label is still dates only.
    expect(screen.getByText('Next due 2026-11-24')).toBeTruthy();
  });

  it('says how many are unpaid and the total in the Billing cell when there is more than one', () => {
    renderList(result([bill()]), {
      billSchedules: { 42: { nextDueDate: '2026-11-24', overdueCount: 0, nextAmountCents: 31244, unpaidCount: 4, outstandingCents: 124976 } },
    });
    expect(screen.getByText('4 unpaid · $1,249.76 outstanding').closest('td')!.getAttribute('data-label')).toBe('Billing');
  });

  it('leaves the Billing cell empty for a single installment', () => {
    const { container } = renderList(result([bill()]), { billSchedules: schedule });
    const billing = container.querySelector('td[data-label="Billing"]')!;
    expect(billing.textContent?.trim()).toBe('—');
  });

  /** Review focus 4. */
  it('shows nothing when every installment is paid', () => {
    const { container } = renderList(result([bill()]), { billSchedules: {} });
    expect(container.querySelector('td[data-label="Price"]')!.textContent?.trim()).toBe('—');
    expect(container.querySelector('td[data-label="Billing"]')!.textContent?.trim()).toBe('—');
  });
});
```

(`bill()` is the file's existing bill-row fixture at id 42.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/lib/warranty/constants.test.ts tests/app/warranties-client.test.tsx`
Expected: `billOutstandingLabel` is not exported; the list tests fail with `—` in the Price cell.

- [ ] **Step 3: Implement**

In `src/lib/warranty/constants.ts`, after `billScheduleLabel`:

```ts
/**
 * Spec 2026-09-30 §2.1. The Billing cell's text for a bill with several unpaid installments. Null
 * for one or none: the Price cell carries a single next amount, and repeating it here would be the
 * same fact twice. Ruling P4 is untouched -- billScheduleLabel above stays dates and counts.
 */
export function billOutstandingLabel(unpaidCount: number, outstandingCents: number): string | null {
  if (unpaidCount <= 1) return null;
  return `${unpaidCount} unpaid · ${formatCents(outstandingCents)} outstanding`;
}
```

(Import `formatCents` from `@/lib/money` if constants.ts does not already.)

In `src/app/(app)/warranties/page.tsx`, replace the fold:

```ts
  const billSchedules: Record<
    number,
    { nextDueDate: string; overdueCount: number; nextAmountCents: number; unpaidCount: number; outstandingCents: number }
  > = {};
  for (const row of unpaidInstallments({
    today,
    windowEnd: addDaysIso(today, 3650),
    includeOverdue: true,
    ownerUserId: scope ?? undefined,
  })) {
    const entry = billSchedules[row.itemId];
    if (entry === undefined) {
      // First row per item is the next due: unpaidInstallments orders by due_date, then id.
      billSchedules[row.itemId] = {
        nextDueDate: row.dueDate,
        overdueCount: row.dueDate < today ? 1 : 0,
        nextAmountCents: row.amountCents,
        unpaidCount: 1,
        outstandingCents: row.amountCents,
      };
    } else {
      if (row.dueDate < today) entry.overdueCount += 1;
      entry.unpaidCount += 1;
      entry.outstandingCents += row.amountCents;
    }
  }
```

In `warranties-client.tsx`, widen the prop type at `:104` to the same shape, and change the two cells:

```tsx
                  <td className="text-right cell-stack-amount" data-label="Price">
                    {/* Spec 2026-09-30 §2.1. A bill's next unpaid amount lives here -- the phone
                        card's amount slot -- because this cell is where money is on every other
                        row. The schedule label beside it stays dates only (ruling P4). */}
                    {row.kind === 'bill' ? (
                      billSchedules[row.id] === undefined ? (
                        <span className="text-subtle">—</span>
                      ) : (
                        <Money cents={billSchedules[row.id].nextAmountCents} plain />
                      )
                    ) : row.priceCents === null ? (
                      <span className="text-subtle">—</span>
                    ) : (
                      <Money cents={row.priceCents} plain />
                    )}
                  </td>
                  <td className="whitespace-nowrap text-right text-muted" data-label="Billing">
                    {row.kind === 'bill' ? (
                      (() => {
                        const schedule = billSchedules[row.id];
                        const label = schedule === undefined ? null : billOutstandingLabel(schedule.unpaidCount, schedule.outstandingCents);
                        return label === null ? <span className="text-subtle">—</span> : <span>{label}</span>;
                      })()
                    ) : row.billingCycle !== null && row.billingAmountCents !== null ? (
                      <>
                        <Money cents={row.billingAmountCents} plain /> {billingCycleSuffixForKind(row.kind, row.billingCycle)}
                      </>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
```

Import `billOutstandingLabel` from `@/lib/warranty/constants`.

- [ ] **Step 4: Add the scoping test (review focus 5) to the page-level test**

Find the test file that renders `WarrantiesPage` or exercises `page.tsx`'s fold (`grep -rln "billSchedules" tests/app` — if only the client test references it, add the following to `tests/lib/warranty/installments.test.ts` instead, against `unpaidInstallments` directly):

```ts
  /** Review focus 5: the amounts ride exactly the scoping the dates already had. */
  it('scopes the amounts the way it already scopes the dates', () => {
    // Two bills, two owners; a self-scoped read for one owner returns only their installment rows,
    // amounts included, and nothing of the other's.
    const mine = seedBillWithInstallment({ ownerUserId: alice, dueDate: '2026-11-24', amountCents: 31244 });
    seedBillWithInstallment({ ownerUserId: bob, dueDate: '2026-10-15', amountCents: 99999 });
    const rows = unpaidInstallments({ today: '2026-10-01', windowEnd: '2036-10-01', includeOverdue: true, ownerUserId: alice });
    expect(rows.map((row) => [row.itemId, row.amountCents])).toEqual([[mine, 31244]]);
  });
```

`seedBillWithInstallment` is a small local helper using `createWarrantyItem(..., { firstInstallment })` from Task 1 — write it in the test file.

- [ ] **Step 5: Run, typecheck, commit**

Run: `npx vitest run tests/lib/warranty/constants.test.ts tests/app/warranties-client.test.tsx tests/lib/warranty/installments.test.ts` — expected PASS.
Run: `npx tsc --noEmit` — expected clean.

```bash
git add "src/app/(app)/warranties/page.tsx" "src/app/(app)/warranties/warranties-client.tsx" src/lib/warranty/constants.ts tests/app/warranties-client.test.tsx tests/lib/warranty/constants.test.ts tests/lib/warranty/installments.test.ts
git commit -m "feat(bills): the list row shows the next amount and what is outstanding

- the fold keeps the amounts it already loaded
- next amount in the Price cell; count and total in Billing when several
- ruling P4 untouched: the schedule label stays dates only"
```

---

### Task 4: The bill's own page leads with its money

**Files:**
- Modify: `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` — summary `<dl>` (`:700-735`), the Installments card (`:995-1175`, moved above Linked transactions at `~:915`), the add-installment inputs (`:1156-1161`, now controlled), the detail uploader (`:1373`, gains `onSuggestions`)
- Test: `tests/app/warranty-detail-client.test.tsx`

**Interfaces:**
- Consumes: `installments: InstallmentRow[]` prop (already passed by `[id]/page.tsx:58`).
- Produces: two `<Detail>` rows for a bill with an unpaid installment: `Next payment` → `$X due DATE`; `Outstanding` → `$Y (N unpaid)` when N > 1.
- Produces: controlled add-installment inputs (`newDueDate`, `newAmount` state) and an `onSuggestions` on the detail uploader that pre-fills them for a bill and shows `Suggested from the attached bill — check it and press Add installment.` Part B supplies `dueDate` in the DTO; until then only the amount pre-fills.

- [ ] **Step 1: Write the failing tests**

In `tests/app/warranty-detail-client.test.tsx`, reuse the file's `billItem` and installment fixture shape (`:785-800`). Append:

```ts
/** Spec 2026-09-30 §2.1: the detail page's summary names the next payment and what is outstanding. */
describe('a bill summary leads with its money', () => {
  const unpaid = (id: number, dueDate: string, amountCents: number) => ({
    id, itemId: 42, dueDate, amountCents, paidAt: null, paidTxnId: null, paidTxn: null, state: 'scheduled' as const,
  });

  it('names the next payment and its date', () => {
    renderDetail({ item: billItem, installments: [unpaid(101, '2026-11-24', 31244)] });
    expect(screen.getByText('Next payment').nextElementSibling?.textContent).toContain('312.44 due 2026-11-24');
    expect(screen.queryByText('Outstanding')).toBeNull();
  });

  it('adds the outstanding total when more than one is unpaid', () => {
    renderDetail({ item: billItem, installments: [unpaid(101, '2026-11-24', 31244), unpaid(102, '2027-01-31', 31244), unpaid(103, '2027-04-30', 31244), unpaid(104, '2027-07-31', 31244)] });
    expect(screen.getByText('Outstanding').nextElementSibling?.textContent).toContain('1,249.76 (4 unpaid)');
  });

  it('shows neither row when nothing is unpaid, and the Installments card is above Linked transactions', () => {
    const { container } = renderDetail({ item: billItem, installments: [] });
    expect(screen.queryByText('Next payment')).toBeNull();
    const text = container.textContent ?? '';
    expect(text.indexOf('Installments (')).toBeLessThan(text.indexOf('Linked transactions'));
  });

  it('pre-fills the add-installment form from an attached bill and says so', async () => {
    renderDetail({ item: billItem, installments: [] });
    // The detail uploader is behind "Add another receipt"; open it, then simulate a finished read.
    fireEvent.click(screen.getByRole('button', { name: /add another receipt/i }));
    const uploaderProps = vi.mocked(ReceiptUploader).mock.calls.at(-1)![0];
    uploaderProps.onSuggestions!({ priceCents: 31244, dueDate: '2026-11-24' });
    await waitFor(() => expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('312.44'));
    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('2026-11-24');
    expect(screen.getByText('Suggested from the attached bill — check it and press Add installment.')).toBeTruthy();
  });
});
```

For the last test, the file must mock the uploader: add near its other mocks

```ts
vi.mock('@/components/warranty/ReceiptUploader', () => ({
  ReceiptUploader: vi.fn(() => <div data-testid="uploader" />),
}));
import { ReceiptUploader } from '@/components/warranty/ReceiptUploader';
```

If the file already renders the real uploader in another test that depends on it, scope this mock with `vi.doMock` inside the describe instead. If the "Add another receipt" control is not a button in this file's render, use the control the existing receipt tests click (grep the file for `Add another receipt`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/app/warranty-detail-client.test.tsx`
Expected: the four new tests FAIL — no `Next payment` row, card order unchanged, uploader has no `onSuggestions`.

- [ ] **Step 3: Implement**

In `warranty-detail-client.tsx`:

1. Summary rows. After the `billingAllowedForKind(...)` `<Detail>` block (`:726-730`), add:

```tsx
                {/* Spec 2026-09-30 §2.1. A bill's money, where the summary is read, built from the
                    installment rows the page already loads. One row for one unpaid; a second with
                    the total when there are several. Nothing when nothing is unpaid, same as the
                    other dead cells this list dropped in v1.16.0. */}
                {(() => {
                  const unpaid = installments.filter((row) => row.paidAt === null);
                  if (item.kind !== 'bill' || unpaid.length === 0) return null;
                  const next = unpaid[0];
                  const outstanding = unpaid.reduce((sum, row) => sum + row.amountCents, 0);
                  return (
                    <>
                      <Detail label="Next payment">
                        <Money cents={next.amountCents} plain /> due {next.dueDate}
                      </Detail>
                      {unpaid.length > 1 ? (
                        <Detail label="Outstanding">
                          <Money cents={outstanding} plain /> ({unpaid.length} unpaid)
                        </Detail>
                      ) : null}
                    </>
                  );
                })()}
```

`installments` arrive ordered by due date from `listInstallments`; if that ordering is not guaranteed in the row type's docblock, sort `unpaid` by `dueDate` first.

2. Card order. Cut the whole Installments `<Card>` block (the one headed by the `{!installmentsAllowedForKind(item.kind) && installments.length === 0 ? null : (` guard) and paste it **immediately before** the Linked transactions card. Nothing inside it changes in this step.

3. Controlled add-installment inputs. Beside `addInstallmentState` (`:347`), add:

```ts
  // Spec 2026-09-30 §2.1. Controlled so an attached bill can pre-fill them (Part B's reader
  // supplies the values); the person still presses Add installment -- nothing saves on its own.
  const [newDueDate, setNewDueDate] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [installmentSuggested, setInstallmentSuggested] = useState(false);
```

Change the two inputs:

```tsx
                  <Field label="Due date">
                    <input type="date" name="dueDate" aria-label="Due date" value={newDueDate} onChange={(e) => setNewDueDate(e.target.value)} className={inputClass} required />
                  </Field>
                  <Field label="Amount">
                    <input name="amount" aria-label="Amount" inputMode="decimal" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} className={inputClass} placeholder="e.g. 1200.00" />
                  </Field>
```

Under them, before `<FormError …>`:

```tsx
                {installmentSuggested ? (
                  <Notice tone="info">Suggested from the attached bill — check it and press Add installment.</Notice>
                ) : null}
```

4. The detail uploader. Change `:1373` to:

```tsx
                <ReceiptUploader
                  key={uploaderKey}
                  onStagedChange={onStagedChange}
                  label="Add another receipt"
                  onSuggestions={
                    installmentsAllowedForKind(item.kind)
                      ? (fields) => {
                          if (fields.priceCents !== undefined) setNewAmount(centsToInput(fields.priceCents));
                          if (fields.dueDate) setNewDueDate(fields.dueDate);
                          if (fields.priceCents !== undefined || fields.dueDate) setInstallmentSuggested(true);
                        }
                      : undefined
                  }
                />
```

Import `centsToInput` from the module `new-warranty-client.tsx` imports it from.

- [ ] **Step 4: Run the detail tests, typecheck, commit**

Run: `npx vitest run tests/app/warranty-detail-client.test.tsx` — expected PASS. If an existing test asserted the old card order, update its expectation and say so in the commit.
Run: `npx tsc --noEmit` — expected clean.

```bash
git add "src/app/(app)/warranties/[id]/warranty-detail-client.tsx" tests/app/warranty-detail-client.test.tsx
git commit -m "feat(bills): the bill page leads with its next payment

- Next payment and Outstanding rows in the summary, from the rows the page loads
- Installments card above Linked transactions
- add-installment form is controlled and pre-fills from an attached bill"
```

---

### Task 5: Help copy

**Files:**
- Modify: `src/app/(app)/help/content.tsx` (Loans & Coverage section, after the paragraph at `:369-375`)
- Test: `tests/app/help.test.tsx` (if it pins section text, add one `toContain`)

- [ ] **Step 1: Add the paragraph**

After the first `<P>` of the Loans & Coverage section, add:

```tsx
        <P>
          A <B>bill</B> is a dated amount, or several. A one-off bill takes its amount and due
          date when you add it; a plan like property tax takes the first and you add the rest on
          its page; a bill that comes back each cycle takes the next amount from the e-bill you
          attach. The list shows the next amount beside the due date, and what is outstanding
          when more than one is unpaid.
        </P>
```

- [ ] **Step 2: Run the help and onboarding guards, commit**

Run: `npx vitest run tests/app/help.test.tsx tests/ops/onboarding-coverage.test.ts` — expected PASS.

```bash
git add "src/app/(app)/help/content.tsx" tests/app/help.test.tsx
git commit -m "docs(help): what a bill is and where its amount shows"
```

**Part A ends here.** Part B (`2026-10-01-receipt-reading.md`) carries the release task for v1.53.0; run it after this plan on the same branch.
