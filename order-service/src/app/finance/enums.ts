/** WebSocket events the finance module publishes. */
export enum FinanceWsEvent {
    /** A payout was recorded; the restaurant's balance moved down. */
    PAYOUT_RECORDED = "finance.payout_recorded",
}
