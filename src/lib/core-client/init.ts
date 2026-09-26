import { StubCoreServiceClient } from '../../pkg/core-client/stub';

// Swap target for the future pkg/core-client/http.ts once core-service's
// endpoint contracts stabilize - see 01-system-design.md §3.1. Every module
// codes against ICoreServiceClient, so that swap needs zero call-site changes.
export const coreServiceClient = new StubCoreServiceClient();
