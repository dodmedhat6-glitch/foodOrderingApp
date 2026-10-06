/**
 * The payment provider port.
 *
 * `pkg/` is framework- and app-agnostic (CLAUDE.md s3): nothing here imports
 * express, the env, the DI container or `AppError`. A provider takes its
 * credentials in its constructor and speaks in the neutral shapes below, so
 * the app layer can swap Kashier for another acquirer — or for a stub in a
 * test — without a line of business code changing.
 *
 * Money crosses this boundary in **minor units**, like everywhere else in the
 * service. Converting to whatever decimal string a provider wants is the
 * provider adapter's job, not the caller's.
 */

export interface CreatePaymentSessionInput {
    /** Our own reference for this payment attempt; echoed back on webhooks. */
    merchantOrderRef: string;
    amountMinor: number;
    currency: string;
    /** Where the provider returns the customer's browser when it is done. */
    returnUrl: string;
    /** Per-session server-to-server notification URL, when we have a public one. */
    webhookUrl?: string;
    /** Opaque, stable id for the paying customer, for the provider's records. */
    customerReference: string;
    customerEmail?: string;
    description?: string;
    expiresAt: Date;
}

export interface PaymentSessionResult {
    providerSessionId: string;
    redirectUrl: string;
    expiresAt: Date;
    /** What we sent, for `payment_sessions.raw_init_payload`. */
    requestPayload: Record<string, unknown>;
}

export interface RefundInput {
    /** The provider's own order id — what its refund endpoint is keyed by. */
    providerOrderId: string;
    amountMinor: number;
    currency: string;
    reason?: string;
    /** Refund a specific prior transaction rather than the order's payment. */
    targetProviderTransactionId?: string;
}

export interface RefundResult {
    /** The provider's id for the refund movement, when it names one. */
    providerTransactionId?: string;
    /**
     * Where the refund stands with the provider. `pending` is the ordinary
     * answer and the reason the refund endpoint replies 202: the final state
     * arrives on a webhook.
     */
    status: PaymentOutcome;
    raw: unknown;
}

export type PaymentOutcome = "succeeded" | "failed" | "pending";

/** What kind of money movement an inbound event is about. */
export type PaymentEventKind = "payment" | "refund" | "void" | "other";

/**
 * A provider webhook, normalised. The app layer settles orders off this shape
 * and never reads a provider's own field names.
 */
export interface ProviderWebhookEvent {
    /** Stable de-dup key for this exact fact. */
    eventId: string;
    /** The provider's own event name, kept for the audit row. */
    eventType: string;
    kind: PaymentEventKind;
    outcome: PaymentOutcome;
    /** The reference we chose at session creation. */
    merchantOrderRef: string;
    providerOrderId: string;
    providerTransactionId: string;
    amountMinor: number;
    currency: string;
    /** Provider's payment method label ('card', 'wallet', ...). */
    method?: string;
    /** Provider response code / message, for the failure path. */
    responseCode?: string;
    responseMessage?: string;
}

export interface IPaymentProvider {
    /** Matches a row in `payment_providers.name`. */
    readonly name: string;

    createSession(input: CreatePaymentSessionInput): Promise<PaymentSessionResult>;

    refund(input: RefundInput): Promise<RefundResult>;

    /**
     * Whether `body` really came from the provider. Takes the parsed body
     * rather than the raw bytes because Kashier signs a canonical projection
     * of the payload, not the transport encoding — see kashier.signature.ts.
     */
    verifyWebhook(body: unknown, signature: string | undefined): boolean;

    /** Normalises a verified webhook body. Throws if it is not one. */
    parseWebhook(body: unknown): ProviderWebhookEvent;
}

/**
 * The only error type a provider adapter throws.
 *
 * `kind` is what the app layer maps onto HTTP: `unavailable` means the
 * provider could not be reached or failed on its own side and the caller may
 * retry (503); `rejected` means the provider understood us and said no, so a
 * retry changes nothing (502, with the provider's message surfaced to
 * operators); `malformed` means a reply or a webhook we could not read at all.
 */
export type PaymentProviderErrorKind = "unavailable" | "rejected" | "malformed";

export class PaymentProviderError extends Error {
    constructor(
        readonly kind: PaymentProviderErrorKind,
        message: string,
        readonly provider: string,
        readonly statusCode?: number,
        readonly body?: unknown,
    ) {
        super(message);
        this.name = "PaymentProviderError";
    }
}
