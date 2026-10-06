import {Knex} from "knex";
import {PaymentProviderEntity} from "../entity/payment-provider.entity";
import {PaymentProviderName} from "../enums";

const PAYMENT_PROVIDER_COLUMNS = ["id", "name", "is_enabled", "priority"];

function toEntity(row: any): PaymentProviderEntity {
    return new PaymentProviderEntity({
        id: Number(row.id),
        name: row.name as PaymentProviderName,
        isEnabled: row.is_enabled,
        priority: Number(row.priority),
    });
}

/**
 * The whole lookup, in one query.
 *
 * Callers need the mapping in both directions — name → id when writing a
 * session, id → name when shaping a response — and the table is two rows
 * seeded by migration. Fetching all of it costs the same as fetching one and
 * saves the response path a second round trip per transaction, which is what
 * a per-row `findById` would have become.
 */
export async function findAllProviders(conn: Knex): Promise<PaymentProviderEntity[]> {
    const rows = await conn("payment_providers").select(PAYMENT_PROVIDER_COLUMNS).orderBy("id");
    return rows.map(toEntity);
}
