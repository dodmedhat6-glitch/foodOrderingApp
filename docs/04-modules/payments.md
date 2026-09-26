# Module: Payments (`app/payments`) — Business Logic & Implementation Plan

Owns writes to: `transactions`, `restaurant_balances`, `payment_providers` (the last one is
migration-seeded only — see `02-database-design.md` §3.4, no runtime writer at all). Depends on
`app/orders` (reads order state; calls back into it via `applyPaymentStatus`, never writes
`orders` directly). Depends on `pkg/kashier` (see `07-kashier-integration.md`).

**Build this module second**, immediately after `orders`, since `POST /orders` for `ONLINE`
payments calls into it synchronously (`04-modules/orders.md` §2 step 8).

## 1. The ledger model, restated plainly

Every movement of money — a customer paying, a refund, the platform's commission, a payout to a
restaurant — is one row in `transactions`. There is no separate "payouts" table (explicit
requirement) and no separate "commission" table. `transaction_type` is what distinguishes them:

| `transaction_type` | `src_acc_id` | `dst_acc_id` | Meaning |
|---|---|---|---|
| `ORDER_PAYMENT` | customer's user id | restaurant owner's user id | customer pays for an order; net amount is credited toward the restaurant (commission is deducted as a separate `COMMISSION` row, not netted into this one — see §2) |
| `REFUND` | restaurant owner's user id (or `NULL` = SYSTEM, if the platform absorbs it) | customer's user id | reverses an `ORDER_PAYMENT`; `refunded_txn_id` points at it |
| `COMMISSION` | restaurant owner's user id | `NULL` (SYSTEM) | platform's cut of an `ORDER_PAYMENT`, debited from the restaurant |
| `PAYOUT` | `NULL` (SYSTEM) | restaurant owner's user id... **wait** | see correction below |
| `ADJUSTMENT` | either, or both `NULL` | either, or both `NULL` | manual admin correction, always requires an audit note in `metadata` |

**Correction on `PAYOUT` direction**: a payout is the platform *sending* money out to the
restaurant's bank account — but in ledger terms, this **reduces** `restaurant_balances.balance`
(the restaurant is "cashing out" what it's owed), so its debit/credit direction on the restaurant
side is the same as if the restaurant were the source: `src_acc_id = restaurant owner's user id`,
`dst_acc_id = NULL` (SYSTEM, meaning "left the platform's books entirely via bank transfer").
This matches the given rule literally ("in case of system admin of DODS we put src acc id as
NULL in case the src is the SYSTEM itself") by symmetry: **the ledger direction always means "the
restaurant balance debited/credited," not "the physical direction cash moves outside the
platform."** This is the load-bearing modeling decision for this whole table — restated in
`02-database-design.md` §1 row 2, cross-referenced here because it's easy to get backwards.

## 2. Restaurant balance calculation

`restaurant_balances.balance_minor` is a running total, updated **only** by
`applyLedgerEntry(restaurantOwnerId, transactionRow)` inside the same DB transaction that inserts
into `transactions` (invariant stated in `02-database-design.md` §3.8). The delta per
`transaction_type`:

| `transaction_type` | Effect on the restaurant's `balance_minor` |
|---|---|
| `ORDER_PAYMENT` (on delivery completion, not on payment — see §3) | `+= amountMinor` |
| `COMMISSION` | `-= amountMinor` |
| `REFUND` where `src = restaurant owner` | `-= amountMinor` |
| `REFUND` where `src = NULL` (platform absorbs) | no change |
| `PAYOUT` | `-= amountMinor` |
| `ADJUSTMENT` | `+=`/`-= amountMinor` per the admin's stated direction |

**Open question, flagged for the team**: the exact commission rate/formula (flat % per order?
per-restaurant negotiated rate?) is not specified anywhere in the source material. Model it as a
`commissionRateBasisPoints` lookup (core-service restaurant config, cached) until a concrete rule
is provided — do not hardcode a percentage in this service.

## 3. When does `ORDER_PAYMENT` actually credit the restaurant?

Two candidate rules exist in the source material, and they're genuinely different:

- **PRD**: "Balance increases when: order is delivered successfully." (the whole point of holding
  funds until delivery is to protect against a paid-but-never-delivered order.)
- **Naive reading of the ledger table**: you might expect the `ORDER_PAYMENT` row itself (created
  at payment time) to immediately credit the balance.

**Resolution, matching the PRD (authoritative)**: the `ORDER_PAYMENT` transactions row is created
and marked `SUCCESS` at **payment confirmation time** (webhook success, or COD collection — see
§5), but it does **not** call `applyLedgerEntry` yet. The balance credit happens later, when
`app/delivery-agent`'s `DELIVER` action fires (`04-modules/delivery-agent.md` §3), which is also
where the `COMMISSION` row is created. This means: **a successful payment moves `orders.paymentStatus`
to `PAID` immediately, but does not touch `restaurant_balances` until delivery completes.** This
two-step design is called out explicitly here because it's the single easiest thing to get wrong
when implementing this module — do not credit the balance in the webhook handler.

## 4. Payment method branching

- **ONLINE**: `POST /payments/init` → Kashier payment session → webhook confirms →
  `orders.paymentStatus = PAID`. See `07-kashier-integration.md` for the full flow.
- **COD**: no `transactions` row is created at order-placement time at all.
  `orders.paymentStatus` starts at `COD_PENDING`. When the agent performs the `DELIVER` action
  (`04-modules/delivery-agent.md` §3), `app/payments` is called to record the cash collection:
  insert an `ORDER_PAYMENT` transaction (`method = COD`, `status = SUCCESS` immediately — no
  provider round-trip needed), set `orders.paymentStatus = COD_COLLECTED`, and run the same
  `applyLedgerEntry`/`COMMISSION` step as the online path. **COD and ONLINE converge to the exact
  same ledger-writing code path at delivery time** — only how the `ORDER_PAYMENT` row's `status`
  gets to `SUCCESS` differs (webhook vs. direct agent confirmation).

## 5. Webhook handling — see `07-kashier-integration.md` §4 for the full protocol

Summary of what `webhook-handler.service.ts` does, restated here in terms of this module's own
tables (the Kashier doc covers signature/idempotency mechanics; this is the ledger-side effect):

1. Verify signature → `400` if invalid, and do not touch the DB at all.
2. Look up `transactions` by `(provider_id, provider_reference_id)`.
3. If already `SUCCESS`/`FAILED` (terminal) → `409`, no writes.
4. Else, in one DB transaction: update `transactions.status`, `provider_status_raw`, `metadata`;
   if the event resolves to `SUCCESS` for a `pay`/`capture` event → set
   `orders.paymentStatus = PAID` (via `orders.repository`'s `applyPaymentStatus`, called from this
   service, never a direct cross-module table write); if it resolves to `FAILURE` → set
   `orders.paymentStatus = FAILED` and `orders.status` stays `PENDING_PAYMENT` (customer may
   retry `POST /payments/init` again — a fresh `transactions` row, fresh Kashier `order`
   reference, same `orders.id`).
5. Return `200`.

## 6. Refunds — see `07-kashier-integration.md` §5

Called from `app/orders` (§4 of `04-modules/orders.md`) or directly by admin action. Creates the
`REFUND` row, calls Kashier, and on the confirming webhook: flips `is_refunded = true` on the
original `ORDER_PAYMENT` row, sets `orders.paymentStatus = REFUNDED`/`PARTIALLY_REFUNDED`, and —
**only if the original `ORDER_PAYMENT` had already been credited to the restaurant's balance**
(i.e. the order had already been delivered before the refund, an edge case admin-initiated
refunds can hit) — also runs the debit side of `applyLedgerEntry` for the refund amount.

## 7. Payouts — see `07-kashier-integration.md` §6

Admin-triggered (no public customer/restaurant-facing "request a payout" endpoint in this
contract — payouts are recorded/initiated by admins, matching the PRD: "Admin records payout
events in system"). Creates a `PAYOUT` transaction (`status = PENDING`), calls Kashier's transfer
API, and applies the ledger debit (§2) either immediately on `PENDING` (optimistic — "accepted,
not sent" per Kashier's own status model) or only on `TRANSFERRED` confirmation
(conservative) — **recommend the conservative option**: debit the balance only when Kashier
confirms `TRANSFERRED`, so a `FAILED` transfer never requires a compensating balance correction.
Reconciliation job (§8) polls `PENDING`/`PROCESSING`/`INITIATED`/`IN_TRANSIT` payouts against
`GET /v2/transfers/:transferId`.

## 8. Reconciliation job (scheduled, not HTTP-triggered)

A periodic job (cadence TBD — infra/DevOps decision) scans `transactions` where
`status IN ('PENDING','PROCESSING')` (backed by `idx_txn_status_pending`) older than a threshold,
and: for `ORDER_PAYMENT`/`REFUND` rows, nothing to poll (Kashier's webhook is the only source of
truth — a stuck `PENDING` row here means the webhook never arrived, which is an alerting
condition, not something to poll around); for `PAYOUT` rows, polls Kashier's transfer-status
endpoint (no payout webhook confirmed available — see `07-kashier-integration.md` §6) and applies
the same status-transition logic as the webhook path would.

## 9. Implementation plan (in order)

1. **Migrations**: `transactions`, `payment_providers` (+ seed row for `KASHIER` and `COD`),
   `restaurant_balances`, all enums (`transaction_type`, `transaction_method`,
   `transaction_status`) and indexes from `02-database-design.md` §3.3, §3.4, §3.8.
2. **`pkg/kashier`**: HTTP client, hashing functions, wire types (see
   `07-kashier-integration.md` §7). Unit-test the hashing function against the documented test
   vector before wiring anything else.
3. **`lib/kashier/init.ts`**: env wiring, DI registration.
4. **Entities**: `entity/transaction.entity.ts`, `entity/restaurant-balance.entity.ts`.
5. **Repository**: `repository/payments.repository.ts` — `insertTransaction`,
   `findTransactionByProviderRef`, `updateTransactionStatus`, `applyLedgerEntry` (the one
   function allowed to touch `restaurant_balances.balance_minor`, using its `version` column for
   optimistic-lock retry), `findTransactionById`, `findPayoutsByOwner`.
6. **Services**: `service/payments.service.ts` (init), `service/webhook-handler.service.ts`,
   `service/refunds.service.ts`, `service/payouts.service.ts`.
7. **DTOs**: `dto/request/init-payment.dto.ts`, `dto/response/payment-init.response-dto.ts`,
   `dto/response/payment.response-dto.ts`.
8. **Controller**: `controller/payments.controller.ts` (note: the webhook route handler is
   thin — signature verification + delegate to `webhook-handler.service.ts` — and explicitly
   bypasses the standard response-envelope helper, per `03-api-contract.md` §3).
9. **Routes**: mount `POST /payments/init`, `POST /payments/webhook/:provider`,
   `GET /payments/:paymentId`; mount router in `src/routes.ts` in the same commit.
10. Unit tests: ledger-direction table (§1), balance-delta table (§2), webhook idempotency
    (replay the same payload twice, assert single balance effect).
11. Wire the internal cross-module functions `initPaymentForOrder`/`refundForOrder` that
    `app/orders` calls (§8/§4 of `04-modules/orders.md`).
