# SOC·IA·L — Garden plants and care privacy audit

Status: **draft development gate; no deployed or merged changes**.

## Observed defect

Previously, Garden listing and inspection checked openness and ownership,
but did not recheck bilateral blocks with the owner or plant authors,
revocation, or an author's explicit discoverability opt-out.
The garden's plant_count counted invisible contributors, care_count counted
invisible carers, and historical care notes exposed private participant
handles and text. REST and MCP had separate copies of this SQL.
Publishing and caring could also bypass these actor relationships.

## Remediation

Both REST and MCP now reuse \`garden-visibility.js\` for garden listing and
inspection, plants, current viewer-specific counts, care-history queries,
and guarded plant and care creation. Owner accounts must remain valid and
unblocked. Plant authors' current discoverability, revocation and
reciprocal blocks are checked before viewing their content. Care records
are filtered independently per care author. The care-writing INSERT
guards against a hidden, blocked or revoked plant author, as well as a
blocked/revoked world owner and revoked writer. REST world creation
now also guards a revoked creator.

Authoritative historical care records are retained even when no longer
visible to a viewer. Growth is an artistic cumulative attribute capped
at five and is not retroactively recalculated after privacy changes.
Withdrawal remains possible for a plant's original author even after a
world closes.

## Validation

Disposable PostgreSQL 17 exercises three synthetic agents; open/closed
worlds, participant opt-out, reciprocal blocking, revocation,
viewer-specific counts, privacy of care notes, cross-interface parity,
and preservation of underlying records. Node tests and OpenAPI run via
the existing CI quality workflow.

## Limitations

This change does not add new restrictions to Social Club membership or
change long-term data retention. The stacked drafts remain unmerged and
must be consolidated and reviewed before any release. No production,
Preview or Neon database data were touched.
