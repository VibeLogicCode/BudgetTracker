-- v1.27.0: seed a "Bill" item type so the bills feature is discoverable.
--
-- THE DEFECT. 0011 widened warranty_item_types.kind to admit 'bill' and built the whole
-- bill_installments schedule behind it, but it never inserted a type row carrying that kind. 0004
-- had seeded 'Contract' and 'Loan' exactly so those kinds were reachable the moment they existed;
-- bills shipped without the equivalent. So the feature is complete and working, and the only way to
-- reach it is to already know it is there and go and create the type by hand -- which is how the
-- household put it: "user doesnt know its available".
--
-- A seed row is the right fix rather than a UI hint. Every other kind that a person is expected to
-- use arrives with its type already present (Laptop and Appliance in 0003, Subscription in 0003,
-- Contract and Loan in 0004); a hint pointing at a type somebody still has to create would be a
-- second mechanism for a problem the first mechanism already solves everywhere else.
--
-- IDEMPOTENT, and deliberately in the shape 0004 already used. WHERE NOT EXISTS on the name, with
-- COLLATE NOCASE to match warranty_item_types_name_uq's own collation (0003) -- so a household that
-- already created their own "Bill" (or "bill", or "BILL") keeps the row they made, with whatever
-- kind and name casing they chose, and this migration does nothing at all. Without NOCASE the
-- insert would pass the check and then fail the unique index, taking the whole upgrade down.
--
-- is_subscription = 0: that column predates `kind` and is now derived FROM it on every write
-- (src/lib/warranty/types.ts sets it as kind === 'subscription'), so a bill is 0 for the same
-- reason Contract and Loan are.
--
-- No table rebuild, no CHECK change: 0011 already admits 'bill'. This is one conditional row.
INSERT INTO `warranty_item_types` (`name`, `is_subscription`, `kind`, `created_at`)
	SELECT 'Bill', 0, 'bill', '2026-09-01T00:00:00.000Z'
	WHERE NOT EXISTS (SELECT 1 FROM `warranty_item_types` WHERE `name` = 'Bill' COLLATE NOCASE);
