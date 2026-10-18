/**
 * Great-circle distance between two WGS84 points, in metres.
 *
 * Used to price an agent's earning at settlement. Redis `GEOSEARCH` measures
 * distance for the *dispatch* decision; this exists because settlement happens
 * long after that search, from the branch and dropoff coordinates on record,
 * with no presence entry left to ask.
 *
 * Straight-line, not driven distance. That is a deliberate simplification and
 * it under-pays slightly on every trip — a routing provider would be the fix,
 * and it is out of scope. What matters here is that it is *consistent*: the
 * same two points always price the same way, and the result is stamped into
 * `agent_earnings` rather than recomputed on read.
 */

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const phi1 = toRadians(lat1);
    const phi2 = toRadians(lat2);
    const deltaPhi = toRadians(lat2 - lat1);
    const deltaLambda = toRadians(lng2 - lng1);

    const a =
        Math.sin(deltaPhi / 2) ** 2 +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;

    // `asin(sqrt(a))` rather than the `atan2` form: both are exact here, but
    // this one cannot produce NaN from floating-point drift pushing the
    // argument a hair above 1, which the `acos` form can for antipodal points.
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function toRadians(degrees: number): number {
    return (degrees * Math.PI) / 180;
}
