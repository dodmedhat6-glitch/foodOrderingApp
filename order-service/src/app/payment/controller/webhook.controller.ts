import {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {logger} from "../../../lib/logger/logger";
import {PaymentWebhookService} from "../service/payment-webhook.service";

/** The header Kashier signs its deliveries with. */
const SIGNATURE_HEADER = "x-kashier-signature";

/**
 * The provider callback endpoint. No `authenticate`, no `rbac`, no region
 * middleware: the provider has none of those to give. The HMAC is the
 * authentication, the merchant reference is the region, and both are checked
 * in the service before anything is read from a database.
 */
@injectable()
export class PaymentWebhookController {
    constructor(
        @inject(TOKENS.PaymentWebhookService)
        private readonly webhookService: PaymentWebhookService,
    ) {}

    /**
     * Always 200 once the signature checks out, whatever the service decided
     * (docs/api-contracts.md s2.2).
     *
     * Not laziness: the only alternatives to a 200 are codes that make the
     * provider resend. For a duplicate, a reference that isn't ours or an
     * amount that doesn't match, resending reaches the same conclusion ten
     * more times over the next day. A genuine processing failure *does*
     * throw, reaches the error handler as a 500, and is retried — which is
     * the one case where retrying is the right answer.
     *
     * The body is deliberately empty. The provider discards it, and a
     * webhook endpoint that reports its internal state to an unauthenticated
     * caller is an oracle: "duplicate" versus "no such order" tells a prober
     * which references exist.
     */
    receive = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await this.webhookService.handle(
                String(req.params.provider),
                req.body,
                headerValue(req, SIGNATURE_HEADER),
            );

            if (!result.processed) {
                logger.warn("payment webhook acknowledged without processing", {
                    provider: req.params.provider,
                    reason: result.reason,
                    correlationId: req.correlationId,
                });
            }

            res.status(200).end();
        } catch (err) {
            next(err);
        }
    };
}

function headerValue(req: Request, name: string): string | undefined {
    const raw = req.headers[name];
    return Array.isArray(raw) ? raw[0] : raw;
}
