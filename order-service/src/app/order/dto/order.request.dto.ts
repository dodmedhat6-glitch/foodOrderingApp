import {Type} from "class-transformer";
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from "class-validator";
import {OrderStatus, PaymentMethod} from "../enums";

export class OrderItemInputDTO {
    @IsInt()
    @Min(1)
    productId!: number;

    @IsInt()
    @Min(1)
    @Max(50)
    quantity!: number;
}

export class CreateOrderRequestDTO {
    @IsInt()
    @Min(1)
    branchId!: number;

    @IsInt()
    @Min(1)
    customerAddressId!: number;

    @IsEnum(PaymentMethod)
    paymentMethod!: PaymentMethod;

    // Capped so one request can't fan out into an unbounded batch upstream.
    @ArrayMinSize(1)
    @ArrayMaxSize(100)
    @ValidateNested({each: true})
    @Type(() => OrderItemInputDTO)
    items!: OrderItemInputDTO[];
}

/**
 * The single status endpoint. Which targets are legal depends on the order's
 * current status and on who is asking — `order-status.service.ts` decides,
 * not this DTO, which only constrains the target to the statuses an HTTP
 * caller is ever allowed to request. `assigned`, `picked` and `delivered` are
 * excluded: those are written by the assignment service and the agent
 * endpoints in later phases.
 */
export class UpdateOrderStatusRequestDTO {
    @IsEnum(OrderStatus)
    status!: OrderStatus;

    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(500)
    reason?: string;
}
