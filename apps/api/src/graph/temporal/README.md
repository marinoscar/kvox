# Temporal engine (`src/graph/temporal/`)

The bitemporal rules of `docs/specs/ontology.md` §5.4, implemented once
(issue #353) so the proposal builder (#365), the commit (#366), retrieval
(#370), the brief (#372) and the write services (#355) cannot disagree about
an edge case. Import everything from `./index`.

## The half-open convention

- Every range is **half-open, `[from, to)`**: `from` is included, `to` is not.
  `[2019, 2024)` and `[2024, 2025)` touch and do **not** overlap.
- `null` on a side means **unbounded** on that side. `to: null` is an open
  (still-current) edge.
- A `null` **range** — a non-temporal relation, or an `unknown`-precision fact —
  is valid at every instant. `isValidAt(null, at) === true` is the same contract
  as the SQL `(valid IS NULL OR valid @> $asOf)`; a parity test holds the two
  together (#370).
- Every instant is a UTC `Date`. Calendar maths uses only the UTC accessors, so
  nothing depends on the process time zone.
- A date written at a precision is its whole unit: `from` is the start of it,
  `to` the end of it. `rangeFromPrecision('2019', '2025', 'year')` is
  `[2019-01-01, 2026-01-01)`, and `formatValid` renders it back as `2019 → 2025`.
  A lone `from` is a point fact spanning one unit unless `openEnded` is passed.
- The Postgres literal is `'[from,to)'`, `'[from,)'` when open, `'(,to)'` when
  unbounded below (`toPgRange` / `fromPgRange`).

## Pure

No Prisma, no Nest, no I/O, no logging, no `Date.now()`, no argument-less
`new Date()`. "Now" is always a parameter. `purity.spec.ts` enforces this for
every non-spec `.ts` file in this folder — the same discipline as
`src/transcripts/editing/`.

## What the planner decides, and what it never does

`planTemporalInsert` answers what a candidate edge **means** against the live
(`accepted`/`edited`) edges of its type: evidence for a known period
(`attach_evidence`), or a new edge with the closes, supersession, self-close
(`candidateTo`) and soft-warning flags (`overlaps`, `unordered`) it implies.
It never writes, never mutates an existing range and never rejects: each close
becomes its own reviewable `closing` proposal row (§7), and an overlap is a
flag a reviewer sees, not an error.

Overlap is checked against **every** in-scope live edge, the same fact
included: a new period of a known fact that straddles an existing one is
created (the planner never merges ranges) and flagged, as §5.4 requires. An
undated edge cannot be ordered against a dated candidate and is flagged
`unordered` rather than closed.
