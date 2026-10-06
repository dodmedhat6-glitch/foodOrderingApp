# Business Logic — Payments Module

Owner module: `app/payment/`

Responsible for online payment initiation (Kashier v3 sessions), webhook handling, transactions ledger writes, and refund execution.

References:
- Kashier Payment Sessions: https://developers.kashier.io/docs/accept-payments/payment-sessions
- Kashier Webhooks: https://developers.kashier.io/docs/webhooks
- Kashier webhook payloads: https://developers.kashier.io/docs/webhooks/payloads
- Kashier refunds: https://developers.kashier.io/docs/accept-payments/refunds

---

## 1. Endpoints

| Endpoint                                        | Auth                                  |
| ----------------------------------------------- | ------------------------------------- |
| `POST /payments/init`                           | customer (idempotent, strict)         |
| `POST /payments/webhook/{provider}`             | none (HMAC verified)                  |
| `GET /payments/{paymentId}`                     | system_admin (or restaurant owner)    |
| `POST /payments/{paymentId}/refund`             | system_admin                          |

`{paymentId}` here is the `transactions.id` of a `charge` row (we call this a "payment" in the public API to avoid leaking ledger semantics).

---

## 2. POST /payments/init

### Request DTO

```ts
class InitPaymentRequestDTO {
  orderId: string;        // public_id (UUID)
}
```

Header: `Idempotency-Key` (strict).

### Algorithm

1. Resolve region; load order via `public_id`.
2. Authorize: caller must be the order's customer; order must be `payment_method = 'online'` and `status = 'pending_payment'`.
3. If a `payment_session` row already exists for this order and is still payable — `status IN ('initialized','pending','authorized')` **and** `expires_at` in the future — return it. This is idempotency at the domain level, below the middleware: it stops a customer who abandoned the tab and pressed "pay" again from leaving a trail of live sessions at Kashier, each of which could still be paid.
4. Otherwise:
   - Mint the merchant reference: `<region>_<publicId>_<attempt>`, where `attempt` is the count of prior sessions plus one (see "The merchant order reference" below).
   - Build the Kashier session payload — amount as a decimal string (Kashier's `amount` is major units; the conversion lives in the adapter), currency from the order, `merchantRedirect` from env, `allowedMethods: "card,wallet"`, `failureRedirect: false`, `expireAt` = now + `PAYMENT_SESSION_TIMEOUT_MIN`.
   - Call `pkg/payments/kashier/kashier.client.ts → createSession(payload)`.
   - On success: insert `payment_sessions` (`status='initialized'`, `provider_session_id`, `merchant_order_ref`, `redirect_url`, `expires_at`, `raw_init_payload`).
5. Return `{ sessionId, providerSessionId, redirectUrl, expiresAt, amount, currency, status }`.

`POST /orders` with `paymentMethod: 'online'` runs step 4 itself and returns
`payment: { sessionId, redirectUrl }` on the placement response, so the happy
path is one round trip. That call is **best-effort**: the order is already
committed and its stock already reserved, so a provider failure returns the
order without a `payment` block rather than failing a placement that worked.
The client's recovery is to call `POST /payments/init`.

### The merchant order reference

Kashier's webhook carries **no session id**. It identifies the payment by the
`order` reference we chose, echoed back as `merchantOrderId` — and that field
is one of the ones the HMAC signs, which makes it the only correlation handle
an attacker cannot forge. Three things ride in it:

- **the region**, because a webhook arrives with no `X-Region` header and we
  cannot look anything up before picking a shard. It cannot ride in `metaData`:
  the signature covers only the fields named in `signatureKeys`, and routing a
  money event on an unauthenticated field would let anyone who guesses the
  format aim it at a shard of their choosing;
- **the order's public id**, a UUIDv7, whose embedded timestamp prunes the
  partitioned `orders` scan to one month;
- **the attempt number**, because Kashier rejects a duplicate order reference
  per merchant (`ERR_ORD_02`) and a customer retrying a failed payment needs a
  reference that has never been used.

### Failure

- Kashier returns 5xx or times out (3 retries with backoff in the client) → 503 with retry-after. The order remains in `pending_payment`; client may retry init.
- Kashier returns 4xx (e.g. invalid currency) → 502 with provider message; alert raised.

---

## 3. POST /payments/webhook/{provider}

### Security

- Provider in path: only `kashier` accepted today; anything else is 404.
- HMAC verification against the **Payment API Key** (`KASHIER_API_KEY`) — there
  is no separate webhook secret in Kashier v3. The digest arrives in
  `x-kashier-signature`; any mismatch → 401, nothing read, nothing written.
- The signature covers a **projection** of the payload, not the raw bytes:
  `data.signatureKeys` names the signed fields, which are sorted, rendered
  `key=urlencode(value)` and joined with `&`. So no raw-body middleware is
  needed — and everything outside that list is unauthenticated and must not be
  trusted. The implementation is pinned to Kashier's published worked example
  in `play/test-kashier-signature.ts`.
- `event` is the *operation*, never an outcome. Kashier sends `pay` for a
  declined card too; the outcome is `data.status`
  (`SUCCESS` / `FAILURE` / `PENDING`), and nothing in this service branches on
  `event` alone.

### Idempotency

Three independent guards, deepest last:

1. `INSERT INTO payment_webhook_events (...) ON CONFLICT (provider_id, provider_event_id) DO NOTHING`, committed on its own connection before the money work. `provider_event_id` is `<transactionId>:<status>` — Kashier's own guidance, and necessary, because one transaction legitimately reports `PENDING` and then `SUCCESS` and those are two facts rather than a duplicate. A conflict is **not** automatically a duplicate: a row with `processed_at IS NULL` is an event that failed mid-processing, and the provider's retry of it must be let through. Only an already-`processed_at` row short-circuits to **200**.
2. `SELECT ... FOR UPDATE` on the session, which serialises two deliveries of the same payment arriving at once.
3. The unique `transactions.idempotency_key` (`kashier:<transactionId>:<status>`), written with `ON CONFLICT DO NOTHING` rather than a catch — inside a transaction a constraint violation aborts everything after it, so yielding in SQL is what keeps the constraint, and not application logic, as the thing that actually prevents a double credit.

### Processing (in one trx on the order's region)

1. Look up `payment_session` by `merchant_order_ref` (`FOR UPDATE`) — the webhook names no session id.
2. Reconcile on `(event kind, data.status)` — **never on `event` alone**:
   - **payment** (`pay` / `authorize` / `capture`), `SUCCESS`:
     - Refuse if the session is already `captured` (a replay), or if `amount` does not match the session (see below).
     - `payment_sessions.status = 'captured'`, `provider_order_id` = Kashier's `kashierOrderId`, `raw_last_payload` stored.
     - Insert `transactions(type='charge', method='online', provider_id=kashier, provider_reference_id=transactionId, status='succeeded', amount, currency, src_acc_id=customer, dst_acc_id=NULL, idempotency_key='kashier:<transactionId>:SUCCESS')`.
     - `orders.status = 'placed'` via `OrderService.transitionBySystem` **inside the same transaction**, so an order can never be `placed` with no charge behind it, nor charged while still awaiting payment.
     - After commit: WS `payment.captured` + `order.status_changed` to `customer:<id>`, `order.created` to `branch:<id>` and `restaurant:<id>`, and the branch's cached order pages are invalidated.
   - **payment**, `PENDING`: `payment_sessions.status = 'pending'`, nothing else. The attempt is in flight.
   - **payment**, `FAILURE`:
     - `payment_sessions.status = 'failed'`.
     - Insert `transactions(type='charge', status='failed', ...)` for the audit trail — it is what a support agent reads when a customer says their card was charged.
     - `orders.status` unchanged (stays `pending_payment`, eligible for retry with a fresh session).
     - WS `payment.failed` to the customer, carrying the provider's reason.
   - **refund** (`refund` / `partial_refund`):
     - Locate the refund row with `findPendingRefundToSettle`: among the order's **pending** refunds, the one matching the provider's transaction id if that narrows anything, otherwise the oldest. Matching on the reference alone is not sufficient — Kashier has been observed returning the same `transactionId` for two separate refunds on one order, so it identifies the order's refund stream rather than a single refund. Refunds on an order are issued one at a time, so FIFO is the rule.
     - `SUCCESS` → `status='succeeded'`; when the refunds against the charge reach its full amount, flag the charge `is_refunded = true`. A partial refund leaves it unflagged: the remaining headroom is the sum, and a boolean cannot express "half". WS `payment.refunded` to the customer.
     - `FAILURE` → `status='failed'`, which frees the amount up for another attempt.
     - Adjusting `restaurant_balances` for a refund on a delivered order lands with the settlement ledger in **Phase 3**; the table does not exist yet.
   - **void / reversal / anything new**: acknowledged and logged. The row in `payment_webhook_events` is the record; a handler written against an event we have never seen in production would be a guess.
3. Stamp `payment_webhook_events.processed_at = NOW()` in the same transaction. If anything threw, roll back, stamp `process_error` on a separate connection, and rethrow → 500 → Kashier retries.

### Refusals vs failures

The endpoint answers **200 for everything it cannot fix by being asked again**,
with the reason logged and stamped in `process_error`: a duplicate, a reference
that is not ours, a region this process does not serve, an amount that does not
match the session, a session that is already captured. A non-2xx would only buy
the same event ten more times over the next day on Kashier's backoff schedule.
It throws — and so answers 500 — only for genuine processing failures, which is
the one case where a retry is the right answer.

The amount check deserves naming: `amount` is a signed field, so a mismatch is
not tampering in transit — it is the provider having captured something other
than what we asked for. Crediting the order would accept an amount nobody
authorised, so the event is refused, recorded, and left for an operator.

The response body is deliberately empty. Kashier discards it, and a webhook
endpoint that reports its internal state to an unauthenticated caller is an
oracle: "duplicate" versus "no such order" tells a prober which references
exist.

### What we do NOT do

- We do not trust the webhook's "status=success" without verifying the HMAC.
- We do not trust `data.hash`. Kashier signs it with a server-side secret we do not hold; `x-kashier-signature` is the merchant-facing signature.
- We do not read anything outside `signatureKeys` for a decision — those fields are unauthenticated.
- We do not modify money state if the webhook is a duplicate (caught by the unique index).

---

## 4. GET /payments/{paymentId}

- Authorization:
  - `system_admin`: always.
  - Restaurant owner: only if the transaction belongs to one of their orders.
- Returns a `PaymentResponseDTO` with: id, orderId, type, method, provider, amount/currency, status, providerReferenceId, timestamps, refunds (if any).

---

## 5. POST /payments/{paymentId}/refund

- Admin-only (`requireRole(SYSTEM_ADMIN)`, not an `rbac()` permission — core's catalog seeds no `payments:refund`, and inventing one here would invent a permission core does not know about). `Idempotency-Key` strict.
- Body: `{ amount?: number, reason: string }`. Omitting `amount` means the full **remaining** refundable amount, which is not the charge amount once a partial refund has gone through — the service computes it rather than the client assuming it.
- Validates: the row is a `charge` or `cod_collection`, `succeeded`, and `amount <= charge.amount - already refunded`. "Already refunded" counts **pending** refunds as well as succeeded ones: a refund in flight is money on its way out, and leaving it out of the sum would let a second request refund it again.
- Addressed to Kashier by its **order** id, which lives on the captured `payment_sessions` row (`provider_order_id`) because that is what the first webhook told us. A charge with no captured session cannot be refunded — that is a data problem, logged as such.
- Writes `transactions(type='refund', method=originalMethod, provider_id=originalProvider, status='pending', amount, currency, src_acc_id=NULL, dst_acc_id=customer, refunded_payment_id=charge.id)` **before** calling Kashier, and the call happens **outside any transaction**. Both deliberate: a crash between the two leaves a visible pending refund rather than money moving with nothing to show for it, and holding a row lock across a third party's latency would block every other refund attempt on the same charge.
- The Kashier call is **not retried** — a refund has no idempotency key at the provider, so a retry after a lost reply risks refunding twice. A timeout therefore leaves the row `pending`, which is exactly what it means: we do not know yet, and the webhook will tell us.
- Responds **202**, not 200. Kashier accepting a refund is not the money having moved.
- For COD the cash never reached the platform, so there is no provider call: the refund row is written `succeeded` immediately as a bookkeeping entry. The restaurant-balance side of it lands with the settlement ledger in Phase 3.

---

## 5a. The expiry sweep

`lib/jobs/payment-expiry.ts`, every `PAYMENT_EXPIRY_SWEEP_INTERVAL_SEC`.

Not housekeeping. An online order reserves its stock in core at placement —
*before* the order row exists — so an abandoned checkout holds units out of
circulation indefinitely. `PAYMENT_SESSION_TIMEOUT_MIN` bounds that and this
job enforces it: sessions past `expires_at` and still open are set `expired`,
the order behind each is cancelled with
`status_reason = 'payment_session_expired'`, and the units are released back to
core.

Every step is a compare-and-set, so two workers sweeping one region produce one
cancellation, and a capture landing mid-sweep wins outright — `expireSession`
sees a status that is no longer open and the order is left alone. A capture
that arrives *after* the cancellation still records its ledger row (the money
did move) and is logged for an operator to refund; it does not un-cancel the
order.

---

## 6. Money model (recap)

- All amounts are integer minor units (piasters/halalas).
- `transactions.amount` is always **positive**. The direction is encoded by `(transaction_type, src_acc_id, dst_acc_id)`.
- A successful order generates **two** linked transactions on `delivered`:
  1. `charge` (online) or `cod_collection` — customer → restaurant.
  2. `commission` — restaurant → SYSTEM (src=ownerId, dst=NULL).
- A `payout` is restaurant → bank: src=NULL (system holds the funds), dst=ownerId. The corresponding negative effect on the restaurant balance happens in the same trx.
- A `refund` is SYSTEM → customer (online) or a void with no money movement (cod): we still insert a `refund` row for the audit trail.

---

## 7. RBAC

| Action                              | Role                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| `POST /payments/init`               | `customer` (own order)                                  |
| `POST /payments/webhook/{provider}` | none (signature required)                               |
| `GET /payments/{id}`                | `system_admin`, `restaurant_user` (`payments:read`)     |
| `POST /payments/{id}/refund`        | `system_admin` only (no `payments:refund` permission exists) |

Seed permissions: `payments:read`, mapped only to `owner` (seeded by core's
migration `20261002090100`). There is deliberately **no** `payments:refund`:
refunding is a platform action, gated on the system role rather than on a
restaurant permission, so this service never checks a permission core does not
seed.

---

## 8. Invariants

1. Every `charge` row has at most one matching `refund` chain whose summed amount ≤ charge amount.
2. Webhooks are processed at-most-once **effectively**, at-least-once **delivered**.
3. A `charge` cannot be `succeeded` unless the matching `payment_session` is `captured`.
4. `payment_method='cod'` orders never have a `charge` — only `cod_collection`.
5. The `transactions.idempotency_key` unique constraint guarantees no double-credit on duplicated webhooks — it is the floor beneath the de-dup gate and the session row lock, and it holds even if both are bypassed.
6. An order is `placed` if and only if a succeeded `charge` exists for it: the status transition and the ledger row commit in one transaction.
7. A session's `merchant_order_ref` is globally unique, so a webhook resolves to exactly one session or to none.

---

## 9. Failure modes & operator playbook

| Symptom                                  | Likely cause                                       | Action                                              |
| ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| `payment_session.status='initialized'` for >30 min | the expiry sweep is not running | it should reach `expired` within a minute of `expires_at`; check the job and `PAYMENT_EXPIRY_SWEEP_INTERVAL_SEC` — stock is being held meanwhile |
| rows in `payment_webhook_events` with `process_error` and no `processed_at` | a refused or a failed event | `AmountMismatch` / `SessionNotFound` are refusals needing a human; anything else is a processing failure Kashier will retry |
| a `refund` row stuck `pending` with no `provider_reference_id` | the refund call never got a reply | check the order at Kashier; the money may or may not have moved, which is precisely why the row says `pending` |
| Kashier webhook spike of duplicates      | Kashier retries on slow webhook handler            | check handler latency; HMAC + unique constraint already de-dup |
| Webhook signature mismatch               | secret rotation drift                              | update `KASHIER_WEBHOOK_SECRET`; replay `payment_webhook_events` not yet processed |
| `transactions` insert blocks             | row lock on `restaurant_balances`                  | high contention — investigate concurrent payouts vs deliveries on the same restaurant |

---

## 10. Configuration (env)

```
# Host prefix is the mode: test-api.kashier.io in test, api.kashier.io live.
# A test key never validates against the live host and vice versa.
KASHIER_BASE_URL=https://test-api.kashier.io
KASHIER_MERCHANT_ID=MID-XXXXX-XXX
# Payment API Key: the `api-key` header on session creation AND the HMAC key
# every webhook signature is verified against. There is no KASHIER_WEBHOOK_SECRET
# - Kashier has no separate webhook secret.
KASHIER_API_KEY=...
# Secret Key: the credential, sent raw (no Bearer prefix) in `Authorization`.
KASHIER_SECRET_KEY=...
# v3 has no separate failure URL: `failureRedirect` is a boolean and we send
# false, so a declined card stays on Kashier's page and can be retried there.
KASHIER_RETURN_URL=https://app.quickbite.io/checkout/return
# Per-session server-to-server callback. Empty in a deployed environment
# (dashboard-configured webhooks deliver there); set it to a tunnel URL to
# receive webhooks on a developer machine.
KASHIER_SERVER_WEBHOOK_URL=
KASHIER_TIMEOUT_MS=10000
KASHIER_MAX_FAILURE_ATTEMPTS=3
KASHIER_DISPLAY_LANGUAGE=en
PAYMENT_SESSION_TIMEOUT_MIN=15
PAYMENT_EXPIRY_SWEEP_INTERVAL_SEC=60
```

All added to `lib/config/env.ts` zod schema before any payment code is shipped.
