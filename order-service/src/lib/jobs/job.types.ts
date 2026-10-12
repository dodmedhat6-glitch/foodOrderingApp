/**
 * A background job, as a module declares it. The module owns *what* runs
 * (`handler`) and how often; `lib/jobs/scheduler.ts` owns *how* it runs —
 * overlap protection, error isolation, shutdown.
 */
export interface JobDefinition {
    /** Unique across the process. Registering a name twice throws at boot. */
    name: string;
    intervalMs: number;
    /**
     * Fire once immediately at start, then every `intervalMs`. Off for pure
     * housekeeping that gains nothing from running the instant a process boots.
     */
    runOnStart?: boolean;
    handler: () => Promise<unknown>;
}
