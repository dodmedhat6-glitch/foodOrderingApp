/**
 * An `order_items` row. The `*Snapshot` fields are frozen copies of core's
 * product data at order time, so a historical order renders correctly after
 * the product is repriced, renamed, or deleted.
 */
export class OrderItemEntity {
    id: number;
    region: string;
    orderId: number;
    productId: number;
    quantity: number;
    unitPriceSnapshot: number;
    nameSnapshot: string;
    imageUrlSnapshot: string | null;
    lineTotal: number;
    createdAt: Date;

    constructor(data: Partial<OrderItemEntity>) {
        this.id = data.id!;
        this.region = data.region!;
        this.orderId = data.orderId!;
        this.productId = data.productId!;
        this.quantity = data.quantity!;
        this.unitPriceSnapshot = data.unitPriceSnapshot!;
        this.nameSnapshot = data.nameSnapshot!;
        this.imageUrlSnapshot = data.imageUrlSnapshot ?? null;
        this.lineTotal = data.lineTotal!;
        this.createdAt = data.createdAt ?? new Date();
    }
}
