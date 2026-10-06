import {PaymentProviderName} from "../enums";

/**
 * A `payment_providers` row. The table is a replicated lookup — identical on
 * every shard, seeded by migration, never written at runtime — so this entity
 * exists to give the id→name mapping a type rather than to model a lifecycle.
 */
export class PaymentProviderEntity {
    id: number;
    name: PaymentProviderName;
    isEnabled: boolean;
    priority: number;

    constructor(data: Partial<PaymentProviderEntity>) {
        this.id = data.id!;
        this.name = data.name!;
        this.isEnabled = data.isEnabled ?? true;
        this.priority = data.priority ?? 100;
    }
}
