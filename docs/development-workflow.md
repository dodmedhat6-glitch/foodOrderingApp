# Development Workflow

How a feature is built in this project. The approach is **bottom-up**: start at the
database and work outwards to the HTTP surface, so every layer is written against
something that already exists and can be tested.

## Steps

1. **Database migration** — add or change tables in `core-service/src/migrations/`.
2. **Entity** — create the class in `entity/` that represents the table row.
3. **Repository** — write the queries in `repository/` (or `repo/`).
4. **Service** — create or update the business logic in `service/`.
5. **Controller** — handle request/response mapping in `controller/`.
6. **Routes** — wire the endpoints in the module's `routes.ts`.
7. **Register the router** — if this is the first router for the module, add it to
   `core-service/src/routes.ts`.
8. **Test, then repeat.**

## Notes

- Each module under `core-service/src/app/<module>/` owns its own
  `routes / controller / service / repository / dto / entity` folders, plus
  `errors.ts` and `enums.ts` where needed.
- DTOs validate and shape input and output; entities represent persisted rows.
  Keep them separate.
- Services are registered with the DI container in `core-service/src/lib/di/`
  (`tokens.ts` for the token, `containers.ts` for the binding).
