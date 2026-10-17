# ADR-0003: Graph store: PostgreSQL everywhere (PGlite on Desktop), not LadybugDB

- Status: Accepted
- Date: 2026-10-17
- Related issues: epic #574, #573, #586

## Context

The question was whether an embedded graph database would port better between web and Desktop. The candidate was LadybugDB, a fork of the archived Kùzu, queried with Cypher.

## Decision

PostgreSQL is the single store in both editions. Desktop uses PGlite (Postgres in WebAssembly with `vector`, `pg_trgm` and `uuid-ossp`). `examples/bare-host` already proves it in CI with all platform migrations and the 19 domain migrations.

Reasons:

1. **Same migrations and slice code in both hosts.** That is the real port between the editions.
2. **Database-enforced invariants work as is.** The deferred `kg_assert_has_evidence` trigger, partial unique indexes, pgvector HNSW, trigram and GiST indexes need no re-implementation.
3. **One transaction.** Notes, transcripts and graph commit together.
4. **Cost of change.** The graph slices use about 158 raw SQL calls; a graph database needs a new storage layer under all of them.
5. **The web edition needs more than an embedded database offers.** Multi-user, row-level security and backup and restore do not fit an embedded single-process store. Switching would split the editions.
6. **The reference questions are shallow.** "Action items from Joe" and "meetings with Jenny's boss" are one- or two-hop indexed joins.
7. **Ask never generates SQL or Cypher** ([../specs/ontology.md](../specs/ontology.md) section 9.3), so a query language adds nothing.

## Consequences

- No second storage engine to build, test or ship.
- Deep traversals (many hops) are slower in SQL than in a graph engine. Revisit only if Desktop users need them.
- If revisited: LadybugDB as an optional read-only projection rebuilt from PostgreSQL behind a port, never the system of record.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| LadybugDB as the Desktop store | Splits the editions, loses the database-enforced invariants, needs a new storage layer under the graph slices. |
| LadybugDB in both editions | Cannot serve multi-user, row-level security or backup and restore for the web edition. |
| LadybugDB as a projection now | No current question needs it; added later behind a port if one does. |

## Enforcement

- `examples/bare-host` runs the migrations and the end-to-end test on PGlite and on PostgreSQL 16 + pgvector in CI.
- The raw-SQL index list and `kvox.lock` / `platform.lock` checks ([../PACKAGES.md](../PACKAGES.md)).

## Related issues

#573, #586.
