# search

The search wire contract: the query, the result groups, the semantic degradation reasons and the index status.

## Purpose and scope

The search wire contract: the query, the result groups, the semantic degradation reasons and the index status. Plain Zod schemas, `as const` tuples and inferred types only: no Nest, no `nestjs-zod`, no Node built-in, so it loads in the browser too.

- `search.ts`: `GET /api/search` query and response.
- `search-query.ts`, `search-semantic.ts`, `document-types.ts`: the searchable types, `SEMANTIC_REASONS` and the indexed document kinds.
- `search-index-status.ts`: the per-document and aggregate index status.

The query parsing helpers (`parseTypesParam`, `normalizeQueryText`) and the `search.index` job type stay in the API.

Status: experimental. Moved out of the API DTO files by issue 5.2 (marinoscar/kvox#488) with no change to a field name or a value; every wire shape here is permanent (add, never rename).

## Entry point

`@marinoscar/kvox-contract/search`. The slice depends on `errors`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`, required. The slice imports no other package.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes data shapes, not extension points.
