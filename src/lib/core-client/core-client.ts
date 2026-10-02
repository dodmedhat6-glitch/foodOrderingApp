import {env} from "../config/env";
import {AppError} from "../error/AppError";
import {retry} from "../../pkg/utils/retry";
import {coreUnavailableError, coreUpstreamError} from "./errors";
import {CoreClientRequest, CoreEnvelope} from "./types";

export class CoreClient {
    constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

    async request<T>(req: CoreClientRequest): Promise<T> {
        const url = new URL(req.path, this.baseUrl);

        // core-service reads this exact header name in lib/auth/api-key.guard.ts.
        // It hashes the value and looks it up in its `api_keys` table (seeded from
        // core's own ORDER_SERVICE_API_KEY), so the key must match verbatim — there
        // is no plain env comparison on the other side.
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
        };
        if (req.correlationId) headers["X-CorrelationId"] = req.correlationId;
        if (req.idempotencyKey) headers["Idempotency-Key"] = req.idempotencyKey;

        return retry(
            async () => {
                const res = await fetch(url, {
                    method: req.method,
                    headers,
                    body: req.body ? JSON.stringify(req.body) : undefined,
                });
                if (res.status >= 500) throw coreUnavailableError(res.status);
                if (!res.ok) throw coreUpstreamError(res.status, await parseBody(res));
                if (res.status === 204) return undefined as T;
                return (await res.json()) as T;
            },
            {
                attempts: 3,
                initialDelayMs: 50,
                maxDelayMs: 500,
                isRetryable: (err) => !(err instanceof AppError) || err.statusCode === 503,
            },
        );
    }

    /**
     * Same as `request`, but unwraps core's `{success, data}` envelope so
     * endpoint wrappers deal in the payload type alone.
     */
    async call<T>(req: CoreClientRequest): Promise<T> {
        const envelope = await this.request<CoreEnvelope<T>>(req);
        return envelope.data;
    }
}

async function parseBody(res: Response): Promise<unknown> {
    const text = await res.text().catch(() => "");
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

export const coreClient = new CoreClient(env.core.baseUrl, env.core.internalApiKey);
