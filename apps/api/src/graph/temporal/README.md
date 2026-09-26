# `graph/temporal` — the pure temporal engine

Issue #353, epic #344. The one implementation of `docs/specs/ontology.md` §5.4
(ranges with precision, the closing rule, the out-of-order rule, soft
overlap) and §9.1's `as_of`, shared by proposal building (#365), the commit
(#366), retrieval (#370), the brief (#372) and the write services (#355).
Import everything from `./index`.

## Conventions

- **Half-open ranges.** A `ValidRange` is `[from, to)`: `from` inclusive,
  `to` exclusive, `null` means unbounded on that side. Touching ranges
  `[a, b)` and `[b, c)` do **not** overlap. This is Postgres's own
  `tstzrange` convention, so `isValidAt(range, at)` and the SQL
  `(valid IS NULL OR valid @> $asOf)` answer identically — #370 holds them
  to that with a parity test.
- **`null` range = always valid.** A non-temporal relation or an `unknown`
  precision fact has no range, and `isValidAt(null, at)` is `true`.
  `unknown` is never turned into a guessed range.
- **UTC only.** Every instant is a UTC `Date`; every calendar computation
  uses the UTC accessors, so no output depends on the process time zone.
- **Precision is display, not storage.** `'2026'` at `year` precision is
  stored as `[2026-01-01, 2027-01-01)`; `formatValid` renders it back as
  `2026`. An upper bound renders as the last unit the range still covers.

## Pure: no Prisma, no Nest, no clock

Nothing here imports Prisma or NestJS, reads `process.env`, or reads the
clock (`Date.now`, an argument-less `Date` constructor). "Now" is always a
parameter — a clock inside the engine would make `as_of`, and every test,
time-dependent. `purity.spec.ts` enforces this, in the same spirit as
`src/transcripts/editing/`.

## What the planner does not do

`planTemporalInsert` **decides**; it never writes. A `create` plan's
`closes` become `kind: 'closing'` proposal rows and its `flags`
(`overlaps`, `unordered`) become item flags (#365); nothing closes an edge
until a reviewer accepts that row (§7). Overlap is only ever a warning.

`RelationTypeSpec`'s `temporal` / `exclusive` / `exclusiveScope` are
declared locally in `types.ts` (`TemporalRelationRule`) until #350's
`@app/shared/ontology` merges; it then becomes a `Pick<>` of that type.
