/**
 * Order pricing constants.
 *
 * Money is in minor units everywhere in this service (CLAUDE.md s7/Money), so
 * this is 10 piasters / cents — not 10 EGP.
 */

/**
 * The platform's flat service fee, added to every order regardless of
 * subtotal, branch or region.
 *
 * Flat rather than a percentage of the subtotal, and a constant rather than
 * config, because today it is the same number everywhere and a single literal
 * is the honest way to say that. It replaces a `PLATFORM_SERVICE_FEE_BPS` env
 * knob that was set to 0 in every environment: a configurable fee nobody
 * configures is a worse contract than a named constant, because the fee a
 * given order was charged then depends on which process computed it.
 *
 * When it does become per-region or per-restaurant, it becomes a lookup
 * (region -> fee, or a column on the branch projection) resolved at pricing
 * time — not a second env var. The order row stores the fee it was actually
 * charged (`orders.service_fee`), so changing this constant never retroactively
 * reprices an existing order.
 */
export const SERVICE_FEE_MINOR = 10;
