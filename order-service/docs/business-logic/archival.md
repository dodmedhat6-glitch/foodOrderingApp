# Archival

Code: `app/archival/`. Keeps the hot database small: only the current year
lives there, and older data moves to the archive shard of the same region.

## What moves

Each run, per region:

1. **Finished orders from previous years** (`delivered`, `cancelled`,
   `rejected`), in batches of 1000. Each order moves together with everything
   attached to it: items, payment sessions, ledger rows (including refunds made
   this year) and agent earnings. An order still in progress waits for the next run.
2. **Payouts** from previous years.
3. **Webhook events** from previous years that were processed. Unprocessed ones
   stay hot so someone can still investigate them.

"Previous year" means anything created before 1 January local time.

## How a batch moves safely

1. Copy the rows into the archive and commit.
2. Delete them from the hot shard and commit.

If the process dies between the two steps, the rows exist in both places, never
in neither. The next run copies again (a no-op for rows already there) and
deletes. If the delete would remove a row that wasn't copied (one written in
between), it rolls back and the batch is retried.

## When it runs

- The worker wakes every hour and only works between 02:00 and 05:00 local time.
- At most 60 minutes per region per night; the next night continues from there.
- A Redis lock per region makes sure only one run happens at a time.
- `npm run archive:now [-- --region=eg]` runs it immediately.

Settings: `ARCHIVAL_*` in `.env.example`.

## Reading archived data

| Read | Behaviour |
| --- | --- |
| `GET /customer/orders?year=<previous>` | Reads hot and archive, merges, removes duplicates |
| Restaurant order list with `from` in a previous year | Same |
| `GET /orders/:id` | Hot first; if not found and the id is from a previous year, the archive |
| Finance payouts / summary over a previous year | Both shards |
| Payment by id, refunds, status changes | Hot only |

Both shards are read, rather than switching to the archive, because right after
New Year last year's data is still hot until the worker has run.

## Housekeeping

The same module purges expired rows from `idempotency_keys` every hour.
