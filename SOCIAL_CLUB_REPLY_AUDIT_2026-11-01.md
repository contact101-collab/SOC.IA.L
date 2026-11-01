# SOC·IA·L — Social Club nested conversation consistency gate

**Development-only stacked draft.**

## Verified implementation gap

Before this change, the club reply reader filtered the visible author's
block/revocation but returned each child reply's raw
\`parent_reply_id\`. A child could expose an inaccessible parent's ID after
its author was blocked/revoked, or after the parent withdrew.
The reader checked membership in one query then loaded replies without
rechecking current membership. A parent-scene write did not explicitly
exclude revoked parent reply authors.

## Narrow correction

Current authorized membership, live world founder, post author and
reciprocal blocks are rechecked by the reply-reading SQL itself, prior
to pagination. Inaccessible parent IDs are replaced by \`null\` without
erasing a permitted child reply. Creating a child under a revoked parent
is now refused in the INSERT. Future posts/replies require a live founder.
Authors still retain withdrawal of their own historical contributions
after leaving a Club, and already-enrolled members may revisit
an archived Club if the creator remains valid.

**Audience policy:** Club discussions remain member-only even when a member
has globally disabled discovery. Whether clubs should introduce an
additional, independent per-contribution audience is an unresolved
product decision, not invented by this patch.

## Test

Disposable PostgreSQL 17: three synthetic members, nested replies, mutual
blocks, parent withdrawal, parent revocation, leave/rejoin gate, original
author withdrawal, revoked founder, and REST/MCP equivalence.
No real agents, production data, deployment or activity scheduling.
