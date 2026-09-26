# Kashier Integration (Payment Provider — v3 / Payment Sessions)

> Source: https://developers.kashier.io/docs, `/docs/accept-payments/payment-sessions`,
> `/docs/get-started/api-keys`, `/docs/direct-api/hashing`, `/docs/webhooks`, `/docs/payouts`.
> Some fields below are marked **VERIFY AT IMPLEMENTATION** where Kashier's docs site did not
> yield the full field list through automated fetch — these must be confirmed against the live
> docs (or a Kashier sandbox account) before the payments module is built, not assumed correct.

## 1. Credentials & modes

Every Kashier merchant account has **four keys total**: a Payment API Key + Secret Key pair for
**test** mode, and the same pair for **live** mode.

| Key | Used for | Sent as |
|---|---|---|
| Payment API Key | computing the order hash for payment-session creation; verifying webhook signatures and redirect-callback signatures | `api-key` header (direct API) / used as the HMAC key (hashing) |
| Secret Key | authenticating requests to Kashier's own APIs (payment sessions, transfers/payouts, dashboard API) | `Authorization` header |
| Merchant ID (MID) | identifies the merchant account, format `MID-XXXX-XXX` | `merchantId` field / query param |

- Base URL: `test-api.kashier.io` (test) vs `api.kashier.io` (live). A test key **never**
  validates against the live host, and vice versa — this must be a single config toggle
  (`env.kashier.mode`), never a per-request choice.
- Payouts (transfers) write endpoints live on a **different host**: `fep.kashier.io` /
  `test-fep.kashier.io`.
- Store both key pairs in the secret manager / env, never in `payment_providers.config` (that
  column is documented as non-secret routing config only — see `02-database-design.md` §3.4).

## 2. Creating a payment (Payment Session / hosted checkout)

This is the integration mode order-service uses for **online** payments: a single backend call
creates a session, we redirect (or embed) the customer to Kashier's hosted page, then confirm via
webhook + redirect callback.

**Request fields** (to Kashier, from our `payments/init` flow):

| Field | Notes |
|---|---|
| `merchantId` | our MID |
| `order` | **our merchant order reference** — must be unique per attempt; Kashier rejects a duplicate. We use our own `transactions.id` (or a payment-attempt-scoped derivative of it), never the raw `orders.id`, so that a retried/failed attempt on the same order can get a fresh reference without colliding |
| `amount` | decimal string, e.g. `"100.00"` — **conversion boundary**: our ledger stores `amount_minor` (bigint minor units); this is the one place in the codebase that converts minor units → decimal string, done in the `pkg/kashier` adapter, nowhere else |
| `currency` | e.g. `"EGP"` |
| `paymentType` | e.g. `"credit"` |
| `type` | `"one-time"` for standard order payments |
| `merchantRedirect` | our callback URL the customer's browser returns to after paying |
| `customer` | `{ email, reference }` — `reference` = our `customer_id` (soft ref to core-service user) |
| `hash` | see §3 |
| `serverWebhook` | **VERIFY AT IMPLEMENTATION** — optional per-request webhook URL; if set, Kashier posts all events for *this* transaction here regardless of dashboard-level webhook filters. Recommended: set this to our webhook endpoint explicitly per request so we don't depend solely on dashboard configuration |
| `expireAt`, `maxFailureAttempts`, `display`, `allowedMethods`, `description`, `enable3DS` | optional, tune per product requirements — **VERIFY AT IMPLEMENTATION** for exact semantics/defaults |

**Auth headers on the create-session call:**
```
Authorization: <Secret Key>
api-key: <Payment API Key>
Content-Type: application/json
```

**Response:** includes `sessionUrl` — used as the `src` of a redirect or an `<iframe>`. Embedded
checkouts additionally receive `window.postMessage` events: `paymentSuccess`, `urlRedirection`,
`closeIframe` — relevant only if/when a web checkout embeds the iframe directly; the mobile
customer app most likely just opens `sessionUrl` in an in-app browser/webview and relies on the
redirect + webhook, not postMessage.

## 3. Hash / signature generation (request signing)

**Order hash** (attached as the `hash` field when creating a payment):

```
string to sign:  /?payment={merchantId}.{orderReference}.{amount}.{currency}
                 (append ".{customerReference}" when using saved-card tokenization)
algorithm:       HMAC-SHA256, lowercase hex digest
key:             Payment API Key
```

```js
const hash = crypto.createHmac('sha256', paymentApiKey).update(path).digest('hex');
```

**Verified test vector** (useful as a unit test fixture for the `pkg/kashier` hashing function):
input `/?payment=mid-0-1.99.20.EGP` with key `11111` → `606a8a1307d64caf4e2e9bb724738f115a8972c27eccb2a8acd9194c357e4bec`.

**Response/redirect signature** (validating Kashier's redirect callback query params):

```
signed params, in order: paymentStatus, cardDataToken, maskedCard, merchantOrderId, orderId,
                          cardBrand, orderReference, transactionId, amount, currency
format:  key1=value1&key2=value2&...   (missing params signed as the literal string "null")
algorithm: HMAC-SHA256, lowercase hex digest, key = Payment API Key
```

Compare the computed digest against the `signature` query param (or header, depending on
integration point — **VERIFY AT IMPLEMENTATION**) case-insensitively. **Never trust a redirect
callback without verifying this signature** — the redirect is client-controlled and easily forged;
it is only ever used as a UX hint ("show a spinner → success page"), never to actually mark a
payment as paid. The webhook (§4) is the only source of truth for payment state.

Both hashing operations live in **`pkg/kashier/hashing.ts`** — pure functions, no app/env
awareness (per the `pkg`/`lib` boundary in `05-folder-structure.md`), taking the API key as a
parameter. `lib/kashier/init.ts` wires the actual key from `env.kashier.*` and exposes it via DI
to the payments module.

## 4. Webhooks — the source of truth for payment state

**Event types:** `pay`, `authorize`, `capture`, `refund`, `partial_refund`, `void`, `reject`,
`reversal`. **`event` is not a success signal** — always branch on `data.status`
(`SUCCESS`/`FAILURE`/`PENDING`), never on `event` alone.

**Payload:**
```json
{
  "event": "pay",
  "data": {
    "amount": "...",
    "currency": "EGP",
    "kashierOrderId": "...",
    "merchantOrderId": "...",
    "orderReference": "...",
    "method": "card",
    "channel": "online | e-commerce",
    "status": "SUCCESS | FAILURE | PENDING",
    "transactionId": "...",
    "transactionResponseCode": "...",
    "signatureKeys": ["amount", "currency", "..."]
  }
}
```

**Signature verification** (header `x-kashier-signature`, HMAC-SHA256, Payment API Key):

1. Sort `data.signatureKeys` alphabetically.
2. Extract those keys' values from `data`.
3. URL-encode **only the values**.
4. Join as `key1=value1&key2=value2&...` in the sorted order.
5. `HMAC-SHA256(joined_string, paymentApiKey)` → lowercase hex.
6. Compare against `x-kashier-signature`, case-insensitive.

**Reject any webhook that fails signature verification with a `400`, and do not process it.**

### 4.1 Response protocol (must be exact — this drives Kashier's retry behavior)

| We return | Kashier treats as |
|---|---|
| `200` | acknowledged — no retry |
| `409` | **acknowledged, "already processed"** — no retry (this is the idempotent-replay response) |
| anything else, or slower than 30s | unacknowledged — retried |

Retry schedule on unacknowledged events: 2m, 10m, 30m, 1h, 2h, then every 4h, up to 10 total
retries. Implication: **our webhook handler must return `200`/`409` within 30 seconds**, so it
does the minimum synchronous work (verify signature → upsert the `transactions` row
idempotently → return) and defers anything slower (notifying other systems, cache invalidation)
to after the response, exactly like the response-envelope conventions in
`05-folder-structure.md` recommend for hot paths.

### 4.2 Idempotency (webhook-specific, separate from our `Idempotency-Key` header mechanism)

- **Key processing on `(transactionId, status)`.** Our webhook handler:
  1. Looks up `transactions` by `(provider_id, provider_reference_id = transactionId)`
     (unique index — see `02-database-design.md` §3.3).
  2. If found **and** already at a terminal status matching this event → return `409` immediately,
     do nothing else (this is what stops Kashier's retries).
  3. If found and still `PENDING`/`PROCESSING` → apply the transition (update `status`,
     `provider_status_raw`, `metadata`) inside the same DB transaction that updates
     `orders.payment_status` and, on success, `restaurant_balances` (see `04-modules/payments.md`).
  4. If not found at all → this indicates our `payments/init` call never got a `transactions` row
     persisted (shouldn't happen if init always writes a `PENDING` row before calling Kashier) —
     log loudly, still return `200` (don't cause a Kashier retry storm over our own bug), and
     surface to reconciliation.
- Watch for the `ORDER_PAID_BEFORE` response code and an `idempotency` event type as explicit
  replay indicators — **VERIFY AT IMPLEMENTATION** exact shape/wording against live docs.
- Handlers must be safe to run twice with the same payload (the DB-level unique constraint on
  `(provider_id, provider_reference_id)` plus the status-check above is what actually guarantees
  this, not "best effort" code review).

## 5. Refunds

Refund initiation is a call **we make to Kashier** (dashboard API — **VERIFY AT IMPLEMENTATION**
for the exact REST endpoint/fields; the docs site did not yield full refund-endpoint details
through automated fetch, only that it's covered "within the Dashboard API section"). Regardless of
the exact wire format, the flow through our ledger is fixed:

1. Admin/support triggers a refund (full or partial) for an existing `ORDER_PAYMENT` transaction.
2. We call Kashier's refund endpoint with the original `transactionId` (Kashier's, i.e. our
   stored `provider_reference_id`) and the refund amount.
3. We insert a new `transactions` row: `transaction_type = REFUND`, `refunded_txn_id` = the
   original payment's `id`, `src_acc_id` = the restaurant owner (or `NULL`/SYSTEM if the platform
   is absorbing it), `dst_acc_id` = the customer, `status = PENDING`.
4. Kashier's `refund`/`partial_refund` webhook event confirms the outcome, following the exact
   same idempotent-upsert path as §4.2, transitioning our `REFUND` row to `SUCCESS`/`FAILED` and,
   on success, flipping `is_refunded = true` on the original `ORDER_PAYMENT` row and adjusting
   `orders.payment_status` to `REFUNDED`/`PARTIALLY_REFUNDED`.

## 6. Payouts (Kashier Transfers API)

Used to actually move money out to a restaurant's bank account once an admin records a payout —
our `transactions.transaction_type = PAYOUT` row is the ledger entry; the Kashier transfer is the
real-world movement that backs it.

| | |
|---|---|
| Read endpoints | `GET /v2/transfers`, `GET /v2/transfers/:transferId`, `POST /v2/transfers/fee-inquiry` — host `api.kashier.io` |
| Create (single) | `POST /v3/transfers/single` — host `fep.kashier.io` |
| Create (bulk) | `POST /v3/transfers/batch` (1–1000 per batch, XLSX upload) — same host |
| Auth | `Authorization: <Secret Key>`; single transfers may additionally require a `kashier-hash` header (HMAC-SHA256) if the transfers-hashing capability is enabled on the account — **VERIFY AT IMPLEMENTATION** whether our merchant account has this enabled, and if so the exact hash formula for transfers (it is not necessarily the same template as §3) |

**Required fields for a single transfer:** `amount` (min 0.01, wallet max 60,000), `method`
(`bank`/`wallet`/`instant wallet`/`card`/`octo card`/`internal account`), `recipientName`
(3–70 chars), `recipientNumber`, `recipientBank` (required for bank/card methods).
**Optional:** `merchantTransferId` (map this to our `transactions.id` for traceability),
`accountId`, `partyId`, `saveBeneficiary`.

**Status progression:** `PENDING → INITIATED → IN_TRANSIT → TRANSFERRED | FAILED`, asynchronous —
"the transfer is accepted, not sent." Our `PAYOUT` transaction's `status`/`provider_status_raw`
tracks this via polling `GET /v2/transfers/:transferId` (no payout-specific webhook was found in
the docs — **VERIFY AT IMPLEMENTATION** whether transfers emit webhooks at all; if not, a
scheduled reconciliation job polling in-flight transfers is required, using the same
`idx_txn_status_pending` index already defined in `02-database-design.md`).

Recipient bank details for a restaurant's payout come from core-service (restaurant/owner payout
profile) — **not stored in this service's database** — fetched synchronously (cached briefly)
at payout-creation time, matching the sync-communication rule in `01-system-design.md` §3.

## 7. Where this lives in the codebase

```
pkg/kashier/
  client.ts          thin HTTP client (base URL per mode, auth headers) — no app/env awareness
  hashing.ts          order-hash + redirect-signature + webhook-signature pure functions
  types.ts             Kashier's own wire types (PaymentSessionRequest, WebhookPayload, TransferRequest, ...)

lib/kashier/
  init.ts              builds the pkg client with env.kashier.{mode,apiKey,secretKey,merchantId}, registers in DI

app/payments/
  service/payments.service.ts        orchestrates: create session → persist PENDING transaction → return sessionUrl
  service/webhook-handler.service.ts  verify signature → idempotent upsert → update order/balance in one DB txn
  service/refunds.service.ts          orchestrates refund calls + ledger entries
  service/payouts.service.ts          orchestrates transfer calls + ledger entries + reconciliation polling
```

`pkg/kashier` knows nothing about `orders`, `transactions`, or DTOs — it only knows Kashier's wire
protocol. All ledger/business logic lives in `app/payments`, consuming `pkg/kashier` through the
DI-injected client, per the boundary rule in `05-folder-structure.md` §2.
