import {JobDefinition} from "./job.types";

/**
 * The job-name → definition map. Modules call `register` from their own
 * `jobs.ts`; `worker.ts` imports those and hands control to the scheduler.
 * Adding a job never touches this file or the scheduler.
 *
 * Registration is strict for the same reason `core-events/registry.ts` is:
 * two jobs under one name is a wiring mistake, and it throws at boot rather
 * than silently running one of them.
 */
const jobs = new Map<string, JobDefinition>();

export function register(job: JobDefinition): void {
    if (jobs.has(job.name)) {
        throw new Error(`Job already registered: ${job.name}`);
    }
    jobs.set(job.name, job);
}

export function listJobs(): JobDefinition[] {
    return Array.from(jobs.values());
}

/** Only for tests and play scripts that register more than once per process. */
export function resetJobs(): void {
    jobs.clear();
}
