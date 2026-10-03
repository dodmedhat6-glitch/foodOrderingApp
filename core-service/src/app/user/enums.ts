export enum SystemRole {
  SYSTEM_ADMIN = "system_admin",
  RESTAURANT_USER = "restaurant_user",
  CUSTOMER = "customer",
  DELIVERY_AGENT = "delivery_agent",
  // an authenticated other service (order-service, ...), not a human user -
  // see lib/auth/api-key.guard.ts
  SERVICE_ACCOUNT = "service_account",
}
