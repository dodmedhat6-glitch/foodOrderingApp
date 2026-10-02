export enum OutboxStatus {
    PENDING = "pending",
    PUBLISHED = "published",
    FAILED = "failed",
}


export class OutboxEvent {
    id: number;
    eventId: string;
    channel: string;
    eventType: string;
    entityType: string;
    entityId: number;
    payload: object;
    status: OutboxStatus;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    publishedAt: Date | null;

    constructor(data: Partial<OutboxEvent>) {
        this.id = data.id!;
        this.eventId = data.eventId!;
        this.channel = data.channel!;
        this.eventType = data.eventType!;
        this.entityType = data.entityType!;
        this.entityId = data.entityId!;
        this.payload = data.payload ?? {};
        this.status = data.status ?? OutboxStatus.PENDING;
        this.attempts = data.attempts ?? 0;
        this.lastError = data.lastError ?? null;
        this.createdAt = data.createdAt ?? new Date();
        this.publishedAt = data.publishedAt ?? null;
    }
}
