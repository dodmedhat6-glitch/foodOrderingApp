# Module: Restaurant Finance (`app/restaurant-finance`) — Business Logic & Implementation Plan

**Read-only module.** Owns no table writes at all — reads `transactions` and
`restaurant_balances`, both owned (written) by `app/payments`. This is the smallest module and is
built **last**, once `payments` has real ledger data to read.

This split exists because the two concerns are genuinely different consumers of the same data:
`app/payments` is the *processing engine* (webhooks, provider calls, ledger correctness);
`app/restaurant-finance` is a *reporting surface* for restaurant owners/managers. Keeping them
separate means the finance views can evolve (add filters, add summary aggregates) without ever
touching payment-processing code, and vice versa — see the one-writer-per-table rule in
`05-folder-structure.md` §8.

## 1. Balance view

`GET /restaurant/balance` is a direct point read of `restaurant_balances` by `restaurant_id`
(primary key lookup — no computation). If a restaurant somehow has no row yet (shouldn't happen —
the row should be created the first time `app/payments`'s `applyLedgerEntry` runs for that
restaurant, with an `INSERT ... ON CONFLICT DO UPDATE` upsert), return a zero balance in the
service's default currency rather than a `404` — a restaurant with no completed orders yet has a
legitimate balance of zero, not an error state.

## 2. Payout history view

`GET /restaurant/payouts?from=&to=` reads `transactions WHERE dst_acc_id... ` — **correction**:
per the ledger-direction rule in `04-modules/payments.md` §1, a `PAYOUT` row has
`src_acc_id = restaurant owner's user id` and `dst_acc_id = NULL` (SYSTEM). So the actual query
condition is:

```sql
WHERE src_acc_id = :ownerUserId AND transaction_type = 'PAYOUT'
```

(This is corrected here relative to an earlier draft of this document set to make sure the
query direction matches the canonical ledger-direction rule exactly once, in the one place code
will actually be written from — cross-check against `04-modules/payments.md` §1 if the two ever
appear to disagree; that file is authoritative on ledger direction.)

Restricted to the restaurant's **owner** role specifically (PRD lists "View payout history" under
Owner Permissions, not Manager) — enforced at the RBAC layer (`resource: "restaurant-finance:payouts"`),
not by filtering data differently per role.

## 3. Why this view must never write

If `GET /restaurant/payouts` ever needs a "retry this payout" or "dispute this payout" action,
that's a **write**, and it belongs in `app/payments` (which already owns the `PAYOUT` transaction
type and the Kashier transfer client), exposed as a new endpoint there — not bolted onto this
module. This module's repository should not even import the `knex` write helpers beyond `SELECT`
— a reviewer should be able to confirm "this module is read-only" by scanning its repository file
for the absence of `.insert(`/`.update(`/`.del(`.

## 4. Implementation plan (in order, last)

1. No new migrations — this module reads tables already created by `app/payments`.
2. **Repository**: `repository/restaurant-finance.repository.ts` — `findBalance(restaurantId)`,
   `findPayoutHistory(ownerId, from, to, cursor)`. Both are `SELECT`-only.
3. **Service**: `service/restaurant-finance.service.ts` — thin; mostly maps repository rows to
   response DTOs plus the zero-balance default from §1.
4. **DTOs**: `dto/response/restaurant-balance.response-dto.ts`,
   `dto/response/payout-history-item.response-dto.ts`.
5. **Controller**: `controller/restaurant-finance.controller.ts`.
6. **Routes**: mount `GET /restaurant/balance`, `GET /restaurant/payouts`; mount in
   `src/routes.ts` in the same commit.
7. Unit test: confirm the query direction from §2 against a seeded ledger fixture (this is the
   one detail in this whole doc set most likely to get flipped by mistake — a dedicated test
   pinning the correct `src_acc_id`/`dst_acc_id` direction pays for itself).
