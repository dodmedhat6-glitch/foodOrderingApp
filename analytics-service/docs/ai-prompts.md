# Directing an AI through the homework

**The skill you're practising isn't Python.** It's directing an AI through a non-trivial implementation in a language you don't know yet, by anchoring it to a codebase you do. You can't review Python line by line yet — but you *can* review whether it follows the architecture you know from the Node services. So make the AI show its work in terms you can check.

Four habits make that possible:

1. **Make it prove it read the code before it writes any.** An AI that hasn't read `order-service/src/lib/core-events/consumer.ts` will invent a consumer. Ask for a summary of what it found and check that summary against the files.
2. **Node analogue first, Python second.** Ask what the TS version of the thing looks like in this repo, *then* for the Python translation, *then* for where the two differ and why. Every deviation should cite `docs/node-to-python-mapping.md` or be argued.
3. **One slice at a time, verified.** Don't ask for "the three handlers". Ask for one, run it with `play/`, then the next.
4. **Make "done" observable.** The AI is done when `ruff check .`, `mypy .` pass and a specific `play/` command shows a specific Mongo document — not when it says so.

---

## Template 0 — the session opener (use every time)

```
You're working in analytics-service/, a Python (FastAPI, pymongo async, aio-pika) service that
deliberately mirrors two Node services in this monorepo (core-service, order-service).

Before writing any code:
1. Read analytics-service/CLAUDE.md fully and list the rules that apply to the task below.
2. Read these files and summarize, in 3-5 bullets each, what they do and which pattern they follow:
   <list the files relevant to the task — see each template>
3. Tell me which existing file is the closest model for what I'm about to ask, and why.

Do not write code yet. Task: <one sentence>.
```

Check the summary. If it says something false about a file ("the consumer dedupes after the handler runs"), correct it before going on — everything it writes later is built on that summary.

## Template 1 — Node analogue, then Python

```
For <task>, show me:
1. How order-service (or core-service) does the closest equivalent — file paths and a short excerpt.
2. The Python translation in this service's conventions — which files you'll create or edit,
   with full paths, and the signature of every new function/class.
3. Every place your Python differs from the Node pattern beyond syntax, each with the reason
   (cite docs/node-to-python-mapping.md §4 where it applies).
Still no code.
```

## Template 2 — implement and verify

```
Implement step 2 exactly. Then run:
  python -m compileall -q -x "\.venv" . ; ruff check . ; mypy .
and fix anything they report. Then give me the exact play/ commands to prove it works and
the output I should expect from each. Don't claim it works until you've run them.
```

## Template 3 — review against the rules

```
Review your diff against CLAUDE.md §3 (layering), §5 (no inline types in *_service/*_controller/*_repo),
§6 (envelopes, DTOs only), §7 (Mongo rules) and §10 (what to avoid). For each rule, say
"followed" or show the line that breaks it. Then run:
  grep -rnE "^(from|import) (lib|app)\b" pkg
  grep -rnE "^(from|import) app\b" lib | grep -v lib/boot
Both must print nothing.
```

---

## Homework prompts

Prefix each with Template 0, listing the files named.

### H1 — `order.rejected` (needs a publisher change first)

Files to read: `order-service/src/lib/events/*`, `order-service/src/app/order/events.ts`, `order-service/src/app/order/service/order.service.ts` (`transitionInTrx`), `app/analytics/eventhandlers/*`, `app/analytics/repository/agg_restaurant_day_repo.py`.

```
Part A (order-service, TypeScript): add `order.rejected` to lib/events/event-types.ts with an
`OrderRejectedPayload` in lib/events/types.ts that carries orderId, restaurantId, branchId,
currency, total, placedAt, rejectedAt and reason. Enqueue it in transitionInTrx when target is
REJECTED, in the same conn, exactly like order.placed is enqueued for PLACED.

Part B (analytics-service): handle it. Add `rejected_count` to agg_restaurant_day.
Bucket by placedAt, NOT rejectedAt — explain in a comment why (the failure rate divides
rejected by placed; both must be on the same day). Use $inc + $setOnInsert so it works even if
the rejection is consumed before the placement.
Verify: publish placed, then rejected, for the same day; check_mongo shows orders_count 1,
rejected_count 1. Then publish a rejected for a day with no placed: document is created with
orders_count 0.
```

### H2 — `order.delivered` and out-of-order delivery

```
Same structure as H1. Payload carries placedAt and deliveredAt. Handler adds
deliveredAt - placedAt (ms) to delivery_ms_sum and 1 to delivery_ms_count on the placedAt day.
Before coding, list every way `order.delivered` can be consumed before `order.placed`
(separate outbox rows, a DLQ replay, a backfill...) and show how your upsert handles each.
Verify by publishing delivered BEFORE placed and checking the final document is identical to
the in-order case.
```

### H3 — `payment.completed`

```
Decide with me first: what does analytics need from a captured payment that order.placed doesn't
already give it? Propose fields (sums and counts only — explain why not averages). Then do the
publisher change in the payment webhook's capture transaction, next to where order.placed is
enqueued for online orders, and the handler here.
```

### H4 — `agg_branch_day`, `agg_product_day`, `agg_platform_day`

```
Show me the agg_restaurant_day entity, repo and indexes, and list everything that changes for
<collection>: key fields, unique index, range index (with the query each serves), entity,
repo methods. For agg_product_day: an order.placed produces one update per line item. Use
pymongo's bulk_write with UpdateOne operations and ordered=False — one round trip per event —
and explain what ordered=False changes if one update fails.
For agg_platform_day: key by (date, currency); explain why summing across currencies is wrong.
Wire the new repo into AnalyticsService through lib/boot/boot.py, not by importing a global.
```

### H5 — derived endpoints (failure rate, delivery average)

```
Implement GET /api/v1/analytics/restaurants/{restaurantId}/days/failures. No new collection:
derive failureRate from rejected_count / orders_count in the service. First show me how
avgOrderMinor is derived today (service, not repo, not stored). Decide and justify: how is
the rate represented on the wire (basis points as an int? a float?) given the money rules in
CLAUDE.md §6. Add a response DTO, a route with the same guards as /days, an api-contracts.md
entry with every error code.
```

### H6 — `rbac.permissions_changed` consumer

```
Read lib/rbac/cache.py and lib/coreevents/consumer.py. Core does not publish this event today —
confirm that by reading core-service/src/lib/events/events.ts and its outbox, and tell me what
core would need to change. Then, on this side: a second EventConsumer bound to core.events with
its own queue (analytics-service.core-events) and DLQ, whose single handler calls
PermissionsCache.invalidate(role). Explain whether this handler needs the Mongo dedupe ledger
(hint: is invalidating twice harmful?).
```

### H7 — backfill command

```
Design cmd/backfill_aggs/main.py before writing it. It must: read placed orders from each
order-service shard read-only; rebuild aggregates into *_rebuild collections through the same
AnalyticsService methods the consumer uses; then swap collections. Explain why this only works
because we store sums and counts, how to avoid double-counting events the live consumer applies
during the rebuild, and why it shouldn't touch event_ids. Keep cmd/backfill_aggs/main.py as
small as cmd/api/main.py — the wiring goes in a run() under lib/boot.
```

---

## Red flags — stop the AI and push back when it…

- writes code before summarizing the files you asked it to read;
- imports `motor`, `beanie`, `mongoengine`, `sqlalchemy`, a DI framework, or Redis;
- puts a collection name in `pkg/`, or imports `app` from `lib/` outside `lib/boot`;
- declares a dataclass or `BaseModel` in a `*_service.py`, `*_controller.py` or `*_repo.py`;
- reads `os.environ` outside `lib/config/env.py`;
- does read-modify-write (`find_one`, add in Python, `replace_one`) instead of `$inc`;
- stores an average, or uses `float`/`round()` for money;
- returns a dict or an entity from a controller;
- uses `datetime.now()` without `UTC`;
- says "this should work" without having run `ruff`, `mypy` and a `play/` command.
