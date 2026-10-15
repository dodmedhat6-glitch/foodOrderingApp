# Restaurant finance

Code: `app/finance/`. The ledger itself belongs to the payment module, and
finance reaches it through `LedgerService`.

## The balance

`restaurant_balances` holds what the platform owes each restaurant, per
currency.

| Event | Balance change |
| --- | --- |
| Order delivered | `+ (subtotal − commission)` |
| Payout recorded | `− amount` |

The balance can go negative (for example, a refund after a payout), and then no
payout is allowed until deliveries bring it back up. Every write locks the row
first, so concurrent deliveries and payouts never lose an update.

## Endpoints

| Endpoint | Who |
| --- | --- |
| `GET /restaurants/:rid/finance/balance` | `finance:read` (owner, branch manager) |
| `GET /restaurants/:rid/finance/payouts?from=&to=` | `finance:read`; defaults to the last 90 days |
| `GET /restaurants/:rid/finance/summary?from=&to=` | `finance:read`; defaults to this month |
| `POST /restaurants/:rid/finance/payouts` | system admin; `Idempotency-Key` required |

Nothing is cached; owners reconcile these numbers against their bank.

## Recording a payout

A payout records a bank transfer that operations has **already made**. It
doesn't move money itself.

1. Lock the balance row.
2. If this `Idempotency-Key` already recorded a payout, return that one.
   A different amount under the same key → 409.
3. If `amount` is more than the balance (or there's no balance in that
   currency) → 409 `InsufficientBalance`.
4. Write a `payout` row and subtract the amount from the balance.
5. Broadcast `finance.payout_recorded` to `restaurant:<id>`.

Step 2 uses the ledger itself (`payout:<restaurantId>:<key>`), so a retry is
safe even after Redis has forgotten the key.

## Summary

Per currency, over the range, counting only `succeeded` ledger rows:

| Field | From |
| --- | --- |
| `grossSales` | `charge` + `cod_collection` |
| `commission` | `commission` |
| `refunds` | `refund` |
| `net` | `grossSales − commission − refunds` |
| `payouts` | `payout` |

Ranges that reach into a previous year also read the archive.
