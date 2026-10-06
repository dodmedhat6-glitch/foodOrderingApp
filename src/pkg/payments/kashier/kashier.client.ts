import {retry} from "../../utils/retry";
import {fromMinor, toMinor} from "../../utils/money";
import {
    CreatePaymentSessionInput,
    IPaymentProvider,
    PaymentEventKind,
    PaymentOutcome,
    PaymentProviderError,
    PaymentSessionResult,
    ProviderWebhookEvent,
    RefundInput,
    RefundResult,
} from "../payment.interface";
import {verifySignature} from "./kashier.signature";
import {
    KASHIER_EVENT,
    KASHIER_STATUS,
    KashierCreateSessionRequest,
    KashierCreateSessionResponse,
    KashierOrderOperationResponse,
    KashierRefundRequest,
    KashierWebhookBody,
} from "./kashier.types";

export interface KashierConfig {
    /** `https://test-api.kashier.io` in test, `https://api.kashier.io` live. */
    baseUrl: string;
    merchantId: string;
    /**
     * The Payment API Key. Two jobs, neither of them authentication: it goes
     * in the `api-key` header on session creation, and it is the HMAC key the
     * webhook signature is verified against.
     */
    apiKey: string;
    /** The Secret Key — the actual credential, in `Authorization`. */
    secretKey: string;
    /** How many failed attempts the hosted checkout allows per session. */
    maxFailureAttempts: number;
    /** Checkout language. */
    display: "en" | "ar";
    timeoutMs: number;
}

const PROVIDER_NAME = "kashier";

/**
 * We offer card and mobile wallet, and nothing else. Installments and BNPL
 * settle on terms this platform has no model for, so they stay off until
 * there is one. (Test mode ignores the field and forces exactly this pair
 * anyway, so the restriction is only observable in live.)
 */
const ALLOWED_METHODS = "card,wallet";

/**
 * Kashier v3 adapter.
 *
 * Holds no app types, no env and no logger: failures leave as
 * `PaymentProviderError` and the app layer decides what they mean in HTTP
 * terms (app/payment/errors.ts).
 */
export class KashierClient implements IPaymentProvider {
    readonly name = PROVIDER_NAME;

    constructor(private readonly config: KashierConfig) {}

    /**
     * Creates a hosted-checkout session (POST /v3/payment/sessions).
     *
     * Only the fields Kashier requires plus the three this service actually
     * needs — `allowedMethods`, `serverWebhook` and `description`. Everything
     * else Kashier accepts is branding or card-on-file behaviour we have no
     * use for, and sending a field we don't mean is a way to be surprised
     * later.
     *
     * Retried on 5xx and transport failures. That is not free: `order` must
     * be unique per merchant, so if the first attempt did reach Kashier and
     * only its reply was lost, the retry comes back as a duplicate-reference
     * rejection. It surfaces as a `rejected` error, the caller's init fails,
     * and the customer's next attempt mints a fresh reference — no money
     * moves either way, and the alternative (never retrying) turns every
     * transport blip into a failed checkout.
     */
    async createSession(input: CreatePaymentSessionInput): Promise<PaymentSessionResult> {
        const body: KashierCreateSessionRequest = {
            merchantId: this.config.merchantId,
            order: input.merchantOrderRef,
            amount: formatAmount(input.amountMinor),
            currency: input.currency,
            merchantRedirect: input.returnUrl,
            expireAt: input.expiresAt.toISOString(),
            maxFailureAttempts: this.config.maxFailureAttempts,
            type: "one-time",
            display: this.config.display,
            allowedMethods: ALLOWED_METHODS,
            customer: {reference: input.customerReference, email: input.customerEmail},
            description: input.description,
            serverWebhook: input.webhookUrl,
            failureRedirect: false,
        };

        const res = await this.request<KashierCreateSessionResponse>({
            method: "POST",
            path: "/v3/payment/sessions",
            body,
            withApiKey: true,
        });

        const providerSessionId = res._id;
        const redirectUrl = res.sessionUrl;
        if (!providerSessionId || !redirectUrl) {
            throw new PaymentProviderError(
                "malformed",
                "Kashier session response carried no _id/sessionUrl",
                PROVIDER_NAME,
                undefined,
                res,
            );
        }

        return {
            providerSessionId,
            redirectUrl,
            // Kashier echoes expireAt in its own format; we keep the instant we
            // asked for rather than re-parsing it, so the value we return to the
            // client and the value we stored can't disagree.
            expiresAt: input.expiresAt,
            requestPayload: body as unknown as Record<string, unknown>,
        };
    }

    /**
     * PUT /v3/payment/refund/{kashierOrderId}.
     *
     * Not retried. A refund is not idempotent at Kashier — there is no key to
     * replay it under — so a retry after a lost reply risks refunding twice.
     * A timeout therefore leaves our row `pending`, which is exactly what it
     * means: we don't know yet, and the webhook will tell us.
     */
    async refund(input: RefundInput): Promise<RefundResult> {
        const body: KashierRefundRequest = {
            apiOperation: "REFUND",
            reason: input.reason,
            transaction: {
                amount: fromMinor(input.amountMinor),
                targetTransactionId: input.targetProviderTransactionId,
            },
        };

        const res = await this.request<KashierOrderOperationResponse>({
            method: "PUT",
            path: `/v3/payment/refund/${encodeURIComponent(input.providerOrderId)}`,
            body,
            withApiKey: false,
            attempts: 1,
        });

        return {
            providerTransactionId: res.transactionId ?? res.response?.transactionId,
            status: refundOutcome(res),
            raw: res,
        };
    }

    verifyWebhook(body: unknown, signature: string | undefined): boolean {
        const data = (body as KashierWebhookBody | undefined)?.data;
        if (!data || typeof data !== "object") return false;

        return verifySignature(data, signature, this.config.apiKey);
    }

    /**
     * Normalises a verified webhook.
     *
     * Reads `data.status` for the outcome and `event` only for *what kind* of
     * movement it was: Kashier sends the same `event` whether the operation
     * succeeded or failed, so treating the arrival of a `pay` as a payment is
     * the one mistake its docs warn about twice.
     */
    parseWebhook(body: unknown): ProviderWebhookEvent {
        const envelope = body as KashierWebhookBody | undefined;
        const data = envelope?.data;
        if (!data || typeof data !== "object") {
            throw new PaymentProviderError("malformed", "webhook has no data object", PROVIDER_NAME);
        }

        const eventType = typeof envelope?.event === "string" ? envelope.event : "unknown";
        const transactionId = readString(data.transactionId);
        const status = readString(data.status).toUpperCase();
        if (!transactionId || !status) {
            throw new PaymentProviderError(
                "malformed",
                "webhook has no transactionId/status",
                PROVIDER_NAME,
                undefined,
                data,
            );
        }

        return {
            // Kashier's own guidance: key processing on transactionId + status.
            // The pair, not the id alone — one transaction legitimately reports
            // PENDING and then SUCCESS, and those are two facts.
            eventId: `${transactionId}:${status}`,
            eventType,
            kind: eventKind(eventType),
            outcome: outcomeOf(status),
            merchantOrderRef: readString(data.merchantOrderId),
            providerOrderId: readString(data.kashierOrderId),
            providerTransactionId: transactionId,
            amountMinor: toMinor(Number(data.amount)),
            currency: readString(data.currency),
            method: readString(data.method) || undefined,
            responseCode: readString(data.transactionResponseCode) || undefined,
            responseMessage: readMessage(data.transactionResponseMessage),
        };
    }

    private async request<T>(req: {
        method: string;
        path: string;
        body?: unknown;
        withApiKey: boolean;
        attempts?: number;
    }): Promise<T> {
        const url = new URL(req.path, this.config.baseUrl);
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json",
            // Raw value, not a Bearer prefix — Kashier reads the secret key verbatim.
            Authorization: this.config.secretKey,
        };
        if (req.withApiKey) headers["api-key"] = this.config.apiKey;

        return retry(
            async () => {
                const res = await this.fetchWithTimeout(url, {
                    method: req.method,
                    headers,
                    body: req.body === undefined ? undefined : JSON.stringify(req.body),
                });

                const payload = await parseBody(res);
                if (res.status >= 500) {
                    throw new PaymentProviderError(
                        "unavailable",
                        `Kashier ${req.method} ${req.path} failed with ${res.status}`,
                        PROVIDER_NAME,
                        res.status,
                        payload,
                    );
                }
                if (!res.ok) {
                    throw new PaymentProviderError(
                        "rejected",
                        messageOf(payload) ?? `Kashier rejected ${req.method} ${req.path}`,
                        PROVIDER_NAME,
                        res.status,
                        payload,
                    );
                }
                return payload as T;
            },
            {
                attempts: req.attempts ?? 3,
                initialDelayMs: 100,
                maxDelayMs: 800,
                isRetryable: (err) =>
                    !(err instanceof PaymentProviderError) || err.kind === "unavailable",
            },
        );
    }

    /**
     * `fetch` has no timeout of its own, and a checkout request that hangs
     * holds the customer's HTTP request open with it.
     */
    private async fetchWithTimeout(url: URL, init: RequestInit): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            return await fetch(url, {...init, signal: controller.signal});
        } catch (err) {
            throw new PaymentProviderError(
                "unavailable",
                `Kashier request failed: ${(err as Error).message}`,
                PROVIDER_NAME,
            );
        } finally {
            clearTimeout(timer);
        }
    }
}

/** Minor units -> the decimal string Kashier's `amount` field expects. */
function formatAmount(amountMinor: number): string {
    return fromMinor(amountMinor).toFixed(2);
}

function eventKind(eventType: string): PaymentEventKind {
    switch (eventType) {
        case KASHIER_EVENT.PAY:
        case KASHIER_EVENT.AUTHORIZE:
        case KASHIER_EVENT.CAPTURE:
            return "payment";
        case KASHIER_EVENT.REFUND:
        case KASHIER_EVENT.PARTIAL_REFUND:
            return "refund";
        case KASHIER_EVENT.VOID:
        case KASHIER_EVENT.REVERSAL:
            return "void";
        default:
            return "other";
    }
}

function outcomeOf(status: string): PaymentOutcome {
    if (status === KASHIER_STATUS.SUCCESS) return "succeeded";
    if (status === KASHIER_STATUS.PENDING) return "pending";
    // Anything that is not an explicit success or an explicit pending is a
    // failure. Reading an unknown status as "probably fine" is how money moves
    // for a payment that never happened.
    return "failed";
}

/**
 * A refund's own outcome, read from the operation reply. Kashier reports the
 * resulting state in `response.status`, with the top-level `status` saying
 * only whether it accepted the call.
 */
function refundOutcome(res: KashierOrderOperationResponse): PaymentOutcome {
    const inner = readString(res.response?.status).toUpperCase();
    if (inner === KASHIER_STATUS.SUCCESS) return "succeeded";
    if (inner === KASHIER_STATUS.FAILURE) return "failed";

    const outer = readString(res.status).toUpperCase();
    if (outer === KASHIER_STATUS.FAILURE) return "failed";

    // SUCCESS at the top level means "accepted", not "refunded". Everything
    // that isn't an outright failure waits for the webhook.
    return "pending";
}

function readString(value: unknown): string {
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function readMessage(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
        const en = (value as {en?: unknown}).en;
        if (typeof en === "string") return en;
    }
    return undefined;
}

function messageOf(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const message = (payload as {message?: unknown}).message;
    return typeof message === "string" ? message : undefined;
}

async function parseBody(res: Response): Promise<unknown> {
    const text = await res.text().catch(() => "");
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
