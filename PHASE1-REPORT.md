# Competitor Monitor AI — Phase 1 Report

## Files created

70+ files across a 5-package / 2-app npm-workspaces monorepo. Full list in git history / directory
tree; the load-bearing ones:

- `packages/security/src/{ipBlocklist,resolveHost,safeFetch}.ts` — SSRF protection
- `packages/extraction/src/{httpExtractor,cheerioExtractor,structuredData}.ts` — Extractor interface + Tiers 1-3
- `packages/detection/src/compare.ts` — deterministic verification-state + change-event engine
- `packages/db/prisma/schema.prisma` + `packages/db/src/repositories/*.ts` — schema + tenant-scoped data access
- `packages/queue/src/monitoringQueue.ts` — BullMQ wiring
- `apps/worker/src/pipeline.ts` — Fetch→Extract→Snapshot→Compare orchestration
- `apps/web/src/app/api/**/route.ts` — auth + competitors + monitored URLs + scan trigger + change events
- `README.md` — local dev setup

## Architecture implemented

Exactly the Phase 1 design agreed before coding: HTTP+Cheerio extraction only (no Playwright/Browser
Use code exists — not stubbed, per your "no unneeded abstractions" instruction), deterministic
comparison producing `CHANGED`/`NO_CHANGE`/`FAILED_TO_VERIFY`, manual BullMQ enqueue (no cron),
custom JWT-cookie auth (no OAuth-adapter tables), tenant isolation via a denormalized
`organizationId` column on every tenant-owned table plus repository functions that always require it.

## Database schema

Implemented exactly the reviewed table list plus the two junction/detail tables that list implied
(`extracted_entities` under `snapshots`, `notification_logs` under `reports`): `organizations`,
`users`, `competitors`, `monitored_urls`, `monitoring_jobs`, `snapshots`, `extracted_entities`,
`change_events`, `ai_analyses` (schema only), `reports` (schema only), `notification_logs` (schema
only), `usage_records`. Schema is Prisma-validated (`prisma validate`) and the client generates
cleanly; no migration has been *applied* anywhere since no Postgres was reachable in this
environment (see Risks).

## Tests — what actually ran, with real output

| Package | Tests | Result |
|---|---|---|
| `packages/security` | 34 | **34 passed** — IP allowlist (19 cases incl. cloud metadata, IPv4-mapped IPv6), DNS-rebinding-resistant resolution (8 cases), HTTP mechanics against a real local server (7 cases) |
| `packages/extraction` | 11 | **11 passed** — HTTP tier failure handling, Cheerio JSON-LD/generic price extraction, script/style stripping, SPA-shell detection, hash determinism |
| `packages/detection` | 13 | **13 passed** — all three verification states, price % math + severity bands, product add/remove, GENERIC-entity add/remove exclusion |
| `packages/queue` | 2 | **2 passed** — deterministic job-id derivation |
| `apps/worker` | 5 | **5 passed** — full pipeline orchestration against fake DB/extractor deps (baseline, changed, failed-to-verify, tenant re-validation, always-write-usage) |
| `apps/web` | 9 | **9 passed** — session JWT round-trip/tamper/garbage, Zod schema validation |
| `packages/db` | 5 | **0 executed, 5 skipped** — tenant-isolation suite; no Postgres reachable in this environment |
| `packages/core` | 0 | pure types, exercised indirectly via the above |

**Totals: 74 tests passed, 0 failed, 5 skipped (not "passed" — skipped).** Full monorepo
`npm run typecheck` and `npm test` both exit 0. `next build` (Turbopack) compiles all 9 API routes
successfully.

I am **not** claiming the tenant-isolation code works from these runs — it's written, it typechecks,
and its logic mirrors the pattern already proven by the CheerioExtractor/detection tests (scope
everything by a required id, never trust one alone), but nobody has watched it pass against a real
database in this session. Run `docker compose up -d && npm run db:migrate && npm test` to actually
execute it.

## Remaining risks (honest, not hedge-everything)

1. **Tenant isolation is unverified in this environment** (above) — highest-priority thing to run before writing any more code that touches multi-tenant data.
2. **SSRF protection is verified against unit tests with an injectable DNS resolver, not against a real attacker-controlled DNS record.** The logic (resolve → validate every address → connect to the validated address, never re-resolve) is the textbook mitigation, but I have not run a live DNS-rebinding attack against it.
3. **No live end-to-end run exists** — no test has actually fetched a real competitor page, stored a real Snapshot row, and read back a real ChangeEvent through the API. Everything downstream of "no live Postgres/Redis" is verified at the unit/integration-with-fakes level only.
4. **Generic price-regex extraction is genuinely best-effort** — it will produce noisy `GENERIC` entities on many real pages; I deliberately excluded it from add/remove detection to avoid false positives, but its price-change matching can still misfire on pages with multiple unrelated prices near the same text.
5. **`prisma migrate dev` has never been run** — the schema is valid and the client generates, but no migration file exists yet and no one has confirmed it actually applies cleanly to a real Postgres.
6. Five moderate/high npm audit findings, all in the `vitest`/`vite`/`esbuild` dev-toolchain (dev-server-only CVEs, not exploitable in how we use them — `vitest run`, no dev server exposed). Not urgent, worth revisiting before a major vitest upgrade.
7. Prisma 5.22 is pinned rather than the newest major (7.x) — 7.x requires driver adapters and a `prisma.config.ts` rework I judged out of scope/risk for an MVP foundation; revisit deliberately later, not as a side effect of `npm update`.

## Recommended next phase

Before Phase 2 feature work: **stand up real Postgres + Redis (docker-compose is already written) and run the full suite once for real**, including `prisma migrate dev` and the tenant-isolation suite. That's a same-day task and it's the one thing in this report I can't vouch for from unit tests alone. After that, Phase 5 (Playwright escalation) or Phase 8 (dashboard UI) are the natural next steps — my recommendation is the dashboard next, since Phase 1 already has a working API and the fastest way to find design/data-model gaps is to build the first real screen against it.
