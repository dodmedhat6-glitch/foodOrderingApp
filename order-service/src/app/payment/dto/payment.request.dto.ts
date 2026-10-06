import {IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength} from "class-validator";

/**
 * `POST /api/payments/init`. The order's public id is the whole request: the
 * amount, currency and payer all come from the order row, never from the
 * client — a client-supplied amount is a client-supplied price.
 */
export class InitPaymentRequestDTO {
    @IsUUID()
    orderId!: string;
}

/**
 * `POST /api/payments/{paymentId}/refund`.
 *
 * `amount` is minor units, like every money field on the wire. Omitted means
 * the full remaining refundable amount — which is not the same as the charge
 * amount once a partial refund has already gone through, so the service
 * computes it rather than the client assuming it.
 */
export class RefundRequestDTO {
    @IsOptional()
    @IsInt()
    @Min(1)
    amount?: number;

    @IsString()
    @MinLength(1)
    @MaxLength(500)
    reason!: string;
}
