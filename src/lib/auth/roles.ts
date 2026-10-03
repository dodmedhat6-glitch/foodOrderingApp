/**
 * System roles as core-service issues them in the JWT `role` claim
 * (core's src/app/user/enums.ts). Kept as a mirror rather than imported
 * because the two services share only the token contract, not code.
 */
export enum SystemRole {
    SYSTEM_ADMIN = "system_admin",
    RESTAURANT_USER = "restaurant_user",
    CUSTOMER = "customer",
    DELIVERY_AGENT = "delivery_agent",
    SERVICE_ACCOUNT = "service_account",
}
