import {TransactionEntity} from "../../payment/entity/transaction.entity";
import {RestaurantLedgerTotals} from "../../payment/types";
import {RestaurantBalanceEntity} from "../entity/restaurant-balance.entity";
import {FinanceRange} from "../types";

/**
 * Wire shapes for restaurant finance (CLAUDE.md s6). Money is integer minor
 * units beside its currency; timestamps are ISO-8601 UTC. The region and the
 * ledger's idempotency key never cross this boundary.
 */

export class BalanceLineResponseDTO {
    currency!: string;
    /** Minor units. May be negative — see the restaurant_balances migration. */
    balance!: number;
    updatedAt!: string;

    static from(balance: RestaurantBalanceEntity): BalanceLineResponseDTO {
        const dto = new BalanceLineResponseDTO();
        dto.currency = balance.currency;
        dto.balance = balance.balance;
        dto.updatedAt = balance.updatedAt.toISOString();
        return dto;
    }
}

export class RestaurantBalanceResponseDTO {
    restaurantId!: number;
    /** One line per currency. Empty until the first delivery settles. */
    balances!: BalanceLineResponseDTO[];
    asOf!: string;

    static from(restaurantId: number, balances: RestaurantBalanceEntity[]): RestaurantBalanceResponseDTO {
        const dto = new RestaurantBalanceResponseDTO();
        dto.restaurantId = restaurantId;
        dto.balances = balances.map(BalanceLineResponseDTO.from);
        dto.asOf = new Date().toISOString();
        return dto;
    }
}

export class PayoutResponseDTO {
    id!: number;
    amount!: number;
    currency!: string;
    status!: string;
    providerReferenceId!: string | null;
    createdAt!: string;

    static from(payout: TransactionEntity): PayoutResponseDTO {
        const dto = new PayoutResponseDTO();
        dto.id = payout.id;
        dto.amount = payout.amount;
        dto.currency = payout.currency;
        dto.status = payout.status;
        dto.providerReferenceId = payout.providerReferenceId;
        dto.createdAt = payout.createdAt.toISOString();
        return dto;
    }
}

/** One currency of the finance summary. */
export class FinanceTotalsResponseDTO {
    currency!: string;
    /** Succeeded charges and COD collections — what customers paid. */
    grossSales!: number;
    /** The platform's cut on delivered orders. */
    commission!: number;
    /** Succeeded refunds back to customers. */
    refunds!: number;
    /** `grossSales - commission - refunds`. */
    net!: number;
    /** Bank transfers recorded to the restaurant. */
    payouts!: number;

    static from(totals: RestaurantLedgerTotals): FinanceTotalsResponseDTO {
        const dto = new FinanceTotalsResponseDTO();
        dto.currency = totals.currency;
        dto.grossSales = totals.grossSales;
        dto.commission = totals.commission;
        dto.refunds = totals.refunds;
        dto.net = totals.grossSales - totals.commission - totals.refunds;
        dto.payouts = totals.payouts;
        return dto;
    }
}

export class FinanceSummaryResponseDTO {
    restaurantId!: number;
    range!: {from: string; to: string};
    totals!: FinanceTotalsResponseDTO[];

    static from(
        restaurantId: number,
        range: FinanceRange,
        totals: RestaurantLedgerTotals[],
    ): FinanceSummaryResponseDTO {
        const dto = new FinanceSummaryResponseDTO();
        dto.restaurantId = restaurantId;
        dto.range = {from: range.from.toISOString(), to: range.to.toISOString()};
        dto.totals = totals.map(FinanceTotalsResponseDTO.from);
        return dto;
    }
}
