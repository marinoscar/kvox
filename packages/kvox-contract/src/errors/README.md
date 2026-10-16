# errors

The domain error and reason catalogue: every code a client branches on, with its HTTP status.

## Purpose and scope

The domain error and reason catalogue: every code a client branches on, with its HTTP status. Plain Zod schemas, `as const` tuples and inferred types only: no Nest, no `nestjs-zod`, no Node built-in, so it loads in the browser too.

- `codes.ts`: `KVOX_ERROR_CODES` (keyed by the code string), `KvoxErrorCodeDef`, `KvoxSlice` and `isKvoxErrorCode`.

The per-slice constants (`NOTE_CONFLICT_REASONS` and the other aliases) stay in the slice that owns them; a spec asserts each value is in the catalogue.

Status: experimental. Moved out of the API DTO files by issue 5.2 (marinoscar/kvox#488) with no change to a field name or a value; every wire shape here is permanent (add, never rename).

## Entry point

`@marinoscar/kvox-contract/errors`. The slice depends on no other slice. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`, required. The slice imports no other package.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes data shapes, not extension points.
