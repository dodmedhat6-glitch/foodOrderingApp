# Payments

Code: `app/payment/`, provider adapter in `pkg/payments/kashier/`.

Two methods:
- **COD (cash on delivery)**: no provider. The cash is recorded when the agent
  delivers.
- **Online**: Kashier v3 hosted checkout. Available only where Kashier is
  configured (`eg`).

## Online flow

1. Placing an online order opens a session (also possible later via
   `POST /payments/init`, which returns the open session if there already is one).
   The customer is sent to Kashier's `redirectUrl`.
2. Kashier calls `POST /payments/webhook/kashier`. Every call is saved in
   `payment_webhook_events` first, then processed.
3. **Captured**: the session becomes `captured`, a `charge` row is written, and
   the order moves `pending_payment → placed`. The customer gets
   `payment.captured`; the branch gets `order.created`.
4. **Declined**: the session becomes `failed` and a failed `charge` row is kept
   for the record. The order stays unpaid and the customer can retry; each
   retry is a new session.
5. **Nobody pays**: after `PAYMENT_SESSION_TIMEOUT_MIN` (default 15 min) the
   expiry job closes the session, cancels the order, and gives the stock back to core.

A capture that arrives for an order that's already cancelled is recorded, then
refunded automatically.

## Webhook rules

- The signature (HMAC-SHA256 with the Kashier API key) is checked before
  anything else. A bad signature → 401.
- The webhook carries no session id and no region, so our order reference
  (`<region>_<orderPublicId>_<attempt>`) is how it is matched back.
- Duplicates, unknown references and amount mismatches are answered with 200
  and logged, because a retry wouldn't help. Only a real processing failure
  returns 500, which makes Kashier retry.
- The ledger's unique `idempotency_key` guarantees a webhook can never credit
  twice.

## Refunds (`POST /payments/:id/refund`, admin)

- Only a succeeded `charge` or `cod_collection` can be refunded, up to whatever
  hasn't been refunded yet. Leaving out `amount` refunds the rest.
- **Online**: a `pending` refund row is written, then Kashier is called (never
  inside a transaction). Kashier's refund webhook later marks it `succeeded`.
  The response is 202.
- **COD**: a bookkeeping entry that succeeds immediately.
- A charge is flagged `is_refunded` once its refunds add up to the full amount.
- Cancelling or rejecting a paid online order triggers a refund automatically.

## Reading payments

`GET /payments/:id` (admin) and the branch-scoped version (`payments:read`)
return one ledger row. The order detail also shows a payment summary:
method, status (paid / refunded / …), amount, and refunded amount.
