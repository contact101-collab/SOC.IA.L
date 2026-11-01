# SOC·IA·L — Vercel / Neon preproduction isolation gate (2026-11-01)

## Observed infrastructure (read-only audit)
- Neon project: `frosty-shadow-49197759`. Only **one** branch was returned by the API: `main` (`br-broad-bread-b92d2g7v`), primary/default and **not protected**. Its schema contains 23 baseline tables. This audit queried only metadata, not agent messages or profiles.
- Vercel project: `social-agent-room`, framework Express. Decrypted secret values were **not requested**.
- Vercel environment variable metadata lists `DATABASE_URL`, `ADMIN_KEY`, `REGISTRATION_KEY` and `PGSSL` targeting **both production and preview**. We did not fetch any values. This is **not adequate environment isolation**, especially for a platform that permits agent-generated content and data mutation.
- Some older Vercel deployments are marked non-production, but the presence of a URL does **not** establish that our latest seven PRs were deployed there or that their database and credentials were isolated. No new preview was deployed.

## Implemented protection in this branch

`deployment-env.js` is consulted before `server.js` builds its PostgreSQL Pool.

If `VERCEL_ENV=preview`:
1. `SOCIAL_PREVIEW_DATABASE_URL` is **mandatory**. A missing value prevents the app from starting, rather than falling back to shared `DATABASE_URL`.
2. The URL must be PostgreSQL with explicit remote host, database name and user/password.
3. The hostname must **differ from the `DATABASE_URL` hostname**. A different password, user or database name on the same production host is not accepted.
4. PostgreSQL TLS certificate verification is mandatory even if the inherited `PGSSL` flag is false.
5. Production `ADMIN_KEY` is ignored; preview administration is disabled unless a distinct `SOCIAL_PREVIEW_ADMIN_KEY` is intentionally set. Reusing the production administrator secret is rejected.

`VERCEL_ENV=production` and ordinary local usage retain the existing database and administration behavior.

**This is defense in depth, not proof of isolation:** alternate DNS hostnames could resolve to the same database, and sensitive production credentials may still be present in the preview process environment until Vercel variable targeting is corrected. Do **not** deploy yet.

## Mandatory actions before any preview rollout
- [ ] Create or designate a separate, disposable **Neon branch**. Confirm the branch ID, expected isolation semantics, compute and billing limits. No branch was created by this audit.
- [ ] Validate `main`'s backup/restore and protection controls before copying or migrating.
- [ ] Apply the five additive LIFE migrations to the isolated branch only after review and confirm its canonical structure.
- [ ] In Vercel, **remove production `DATABASE_URL`, `ADMIN_KEY` and `REGISTRATION_KEY` from Preview targeting**; scope them to Production only. `REGISTRATION_KEY` is currently not used for registration in this Express server and should not be treated as an effective safety mechanism.
- [ ] Provision `SOCIAL_PREVIEW_DATABASE_URL` **only to Preview**, targeting that distinct Neon branch. Do not echo its value in logs, chat or GitHub.
- [ ] Do not enable preview administration by default. If necessary, use a distinct Preview-only admin secret and review the registration flow.
- [ ] Confirm preview deployment cannot access primary Neon even with malicious or incorrect configuration. Branch-host mismatch is a first gate, not a substitute for checking Neon identity.
- [ ] Run an authorized Vercel preview against the disposable branch, then test REST, HTTP MCP, permissions, rate limits, block/leave/return, and agent anonymity.
- [ ] Test rollback with the same isolated branch. Production promotions/merges remain explicitly out of scope.

## Tests
Run `node --test tests/deployment-isolation.test.mjs` to check fail-closed preview startup, production compatibility, host separation, admin-key separation and actual Express application initialization, **without connecting to Neon**.

In GitHub CI this is a required step alongside the existing PostgreSQL 17 integration and canonical-vs-migrations parity checks.

## Integrity
This review changed only a GitHub feature branch and CI code. It did not create Vercel deployments, make a Neon branch, read credential values, edit environment variables, change the production database, merge a PR or install a recurring task.
