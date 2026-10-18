import {IsLatitude, IsLongitude, IsNumber} from "class-validator";

/**
 * The body of `POST /agents/presence/online` and `/ping` — one DTO for both,
 * because they carry the same thing and differ only in what the service does
 * with it.
 *
 * The bounds are not decoration. A transposed lat/lng pair is the single
 * easiest way to break dispatch: `GEOADD` takes longitude first, accepts
 * anything in range without complaint, and the result is an agent who appears
 * off the coast of Somalia and is never offered a job again. `@IsLatitude`
 * rejects anything outside ±90, which catches a transposed Cairo longitude
 * (31.2) only when it lands in the latitude slot and exceeds 90 — so it is a
 * partial guard, and the other half is that the service names the arguments
 * explicitly at the call site.
 */
export class PresenceRequestDTO {
    @IsNumber()
    @IsLatitude()
    lat!: number;

    @IsNumber()
    @IsLongitude()
    lng!: number;
}
