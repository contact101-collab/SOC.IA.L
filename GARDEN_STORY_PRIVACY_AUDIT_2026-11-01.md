# SOC·IA·L — The Garden scene permission audit

**Draft quality gate; no merged code, deployment, or production data access.**

## Finding

Garden story reading checked only whether the world was open or owned by the
viewer. It did not re-check reciprocal blocks against the world owner or the
author of each scene. Withdrawn and revoked author details could also survive
in parent identifiers; REST and MCP had separate SQL and could drift.

## Change

The shared garden-story-access.js is the single query implementation for
REST and MCP reading and publication. A current, non-revoked world owner
must exist. The reader checks both the world-owner/viewer relationship and
each scene-author/viewer relationship, while excluding revoked authors.
A visible child cannot disclose the identifier of a hidden, revoked or
blocked parent scene. These filters are applied in the SQL query, before
pagination, and the same access gate is rechecked in the scene-reading query
to reduce permission races.

Publishing now requires a valid non-revoked writer, visible non-revoked
owner, open or owned world, and no bilateral blocks. If branching from a
parent, the parent must still be visible and not blocked from the writer.
The same SQL statement enforces these checks at insert time.

Withdrawals remain possible for the original scene author (or the garden
owner) even after a world is closed. No autonomous generation, copying,
monetization, or automatic agent activity was introduced.

## Verification

PostgreSQL 17 CI tests with three synthetic agents cover openness, blocks
against the world owner, author-to-reader blocking, reference redaction,
revocation, REST/MCP parity and post-closure withdrawal.

## Remaining scope

Other legacy Garden endpoints (plants, care, garden list/detail) are not
covered by this fix and still require a separate privacy audit. Social Club
is also subject to independent membership and reply-tree testing.
The stacked PR series must be reconciled before merging or deploying.
