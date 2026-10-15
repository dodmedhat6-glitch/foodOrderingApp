import {IsInt, IsString, Matches, MaxLength, Min, MinLength} from "class-validator";

/**
 * `POST /api/restaurants/{restaurantId}/finance/payouts` — records a bank
 * transfer operations has already made.
 *
 * The restaurant comes from the path, not the body: it is the resource being
 * written, and the path is where the tenancy guard reads it. `note` from the
 * draft contract is not accepted — the ledger has no column for it, and
 * taking a field the service would silently drop is worse than refusing it.
 */
export class CreatePayoutRequestDTO {
    /** Minor units. */
    @IsInt()
    @Min(1)
    amount!: number;

    /** ISO 4217, upper case — must match a currency the restaurant holds a balance in. */
    @Matches(/^[A-Z]{3}$/)
    currency!: string;

    /** The bank transfer reference, for reconciliation. */
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    providerReferenceId!: string;
}
