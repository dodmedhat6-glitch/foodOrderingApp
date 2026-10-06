import {Knex} from "knex";
import {PaymentSessionEntity} from "../entity/payment-session.entity";
import {OPEN_SESSION_STATUSES, PaymentSessionStatus} from "../enums";
import {CreatePaymentSessionRow, UpdatePaymentSessionInput} from "../types";

const PAYMENT_SESSION_COLUMNS = [
    "id",
    "region",
    "order_id",
    "order_public_id",
    "provider_id",
    "merchant_order_ref",
    "provider_session_id",
    "provider_order_id",
    "redirect_url",
    "amount",
    "currency",
    "status",
    "expires_at",
    "created_at",
    "updated_at",
];

function toEntity(row: any): PaymentSessionEntity {
    return new PaymentSessionEntity({
        id: Number(row.id),
        region: row.region,
        orderId: Number(row.order_id),
        orderPublicId: row.order_public_id,
        providerId: Number(row.provider_id),
        merchantOrderRef: row.merchant_order_ref,
        providerSessionId: row.provider_session_id,
        providerOrderId: row.provider_order_id,
        redirectUrl: row.redirect_url,
        amount: row.amount,
        currency: row.currency,
        status: row.status as PaymentSessionStatus,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

export async function createSession(
    data: CreatePaymentSessionRow,
    conn: Knex,
): Promise<PaymentSessionEntity> {
    const now = new Date();
    const [row] = await conn("payment_sessions")
        .insert({
            region: data.region,
            order_id: data.orderId,
            order_public_id: data.orderPublicId,
            provider_id: data.providerId,
            merchant_order_ref: data.merchantOrderRef,
            provider_session_id: data.providerSessionId,
            redirect_url: data.redirectUrl,
            amount: data.amount,
            currency: data.currency,
            status: data.status,
            expires_at: data.expiresAt,
            raw_init_payload: JSON.stringify(data.rawInitPayload),
            created_at: now,
            updated_at: now,
        })
        .returning(PAYMENT_SESSION_COLUMNS);

    return toEntity(row);
}

/**
 * The webhook's entry point into our data: the merchant reference is the only
 * correlation handle the provider gives back, and it is unique, so this is a
 * single index lookup.
 *
 * `forUpdate` is what serialises two deliveries of the same payment that
 * arrive at once. The unique constraint on `transactions.idempotency_key`
 * would stop the second from crediting anything regardless, but taking the
 * row lock first means the loser blocks and then sees the settled session,
 * rather than racing to a constraint violation we have to interpret.
 */
export async function findSessionByMerchantOrderRef(
    merchantOrderRef: string,
    conn: Knex,
    forUpdate = false,
): Promise<PaymentSessionEntity | undefined> {
    const query = conn("payment_sessions")
        .select(PAYMENT_SESSION_COLUMNS)
        .where("merchant_order_ref", merchantOrderRef);

    if (forUpdate) query.forUpdate();

    const row = await query.first();
    return row ? toEntity(row) : undefined;
}

/**
 * The newest session for an order, whatever state it is in.
 *
 * `POST /payments/init` uses it twice over: to decide whether there is still
 * a payable session to hand back instead of creating a second one, and to
 * derive the next attempt number when there isn't. Ordered by id rather than
 * created_at because attempts within the same millisecond must still have a
 * defined order.
 */
export async function findLatestSessionByOrderId(
    orderId: number,
    conn: Knex,
): Promise<PaymentSessionEntity | undefined> {
    const row = await conn("payment_sessions")
        .select(PAYMENT_SESSION_COLUMNS)
        .where("order_id", orderId)
        .orderBy("id", "desc")
        .first();

    return row ? toEntity(row) : undefined;
}

/** How many attempts this order has made — the next reference's suffix. */
export async function countSessionsByOrderId(orderId: number, conn: Knex): Promise<number> {
    const row = await conn("payment_sessions")
        .where("order_id", orderId)
        .count<{count: string}>("id as count")
        .first();

    return Number(row?.count ?? 0);
}

/**
 * The captured session for an order — the one that holds the provider's order
 * id, which is what a refund is addressed to.
 */
export async function findCapturedSessionByOrderId(
    orderId: number,
    conn: Knex,
): Promise<PaymentSessionEntity | undefined> {
    const row = await conn("payment_sessions")
        .select(PAYMENT_SESSION_COLUMNS)
        .where("order_id", orderId)
        .where("status", PaymentSessionStatus.CAPTURED)
        .orderBy("id", "desc")
        .first();

    return row ? toEntity(row) : undefined;
}

export async function updateSession(
    sessionId: number,
    data: UpdatePaymentSessionInput,
    conn: Knex,
): Promise<PaymentSessionEntity | undefined> {
    const patch: Record<string, unknown> = {status: data.status, updated_at: new Date()};
    // Only written when the event carried one: the provider order id is
    // learned once and must not be erased by a later event that omits it.
    if (data.providerOrderId) patch.provider_order_id = data.providerOrderId;
    if (data.rawLastPayload !== undefined) patch.raw_last_payload = JSON.stringify(data.rawLastPayload);

    const [row] = await conn("payment_sessions")
        .where("id", sessionId)
        .update(patch)
        .returning(PAYMENT_SESSION_COLUMNS);

    return row ? toEntity(row) : undefined;
}

/**
 * Sessions the customer can no longer pay on but which nobody has closed.
 * Backed by idx_payment_sessions_status_expires_at; the limit keeps one sweep
 * tick bounded however long the job has been down.
 */
export async function findExpiredOpenSessions(
    now: Date,
    limit: number,
    conn: Knex,
): Promise<PaymentSessionEntity[]> {
    const rows = await conn("payment_sessions")
        .select(PAYMENT_SESSION_COLUMNS)
        .whereIn("status", OPEN_SESSION_STATUSES as PaymentSessionStatus[])
        .where("expires_at", "<", now)
        .orderBy("expires_at", "asc")
        .limit(limit);

    return rows.map(toEntity);
}

/**
 * Compare-and-set to `expired`. The status predicate is what makes the sweep
 * safe to run on two workers at once, and safe against a capture landing
 * between the scan and the write: a session that has moved on updates zero
 * rows and the caller leaves it alone.
 */
export async function expireSession(sessionId: number, conn: Knex): Promise<boolean> {
    const updated = await conn("payment_sessions")
        .where("id", sessionId)
        .whereIn("status", OPEN_SESSION_STATUSES as PaymentSessionStatus[])
        .update({status: PaymentSessionStatus.EXPIRED, updated_at: new Date()});

    return updated > 0;
}
