# graph

The connected-knowledge wire contract: entities, evidence, proposals, extraction, the read model, brief, export, import, resolution and overview, plus the graph conflict reasons.

## Purpose and scope

The connected-knowledge wire contract: entities, evidence, proposals, extraction, the read model, brief, export, import, resolution and overview, plus the graph conflict reasons. Plain Zod schemas, `as const` tuples and inferred types only: no Nest, no `nestjs-zod`, no Node built-in, so it loads in the browser too.

- `graph-entity.ts`, `graph-evidence.ts`, `graph-attribute-def.ts`, `graph-ontology.ts`, `graph-forget.ts`: entities, evidence spans, attribute definitions, the effective-ontology response and forgetting.
- `proposal.ts` and `proposal-payload.schema.ts`: proposals, items, commit and revert, and the payloads a proposal row holds.
- `extraction.ts`, `resolution.ts`, `graph-read.ts`, `entity-brief.ts`, `graph-overview.ts`: extraction requests, resolution, the read model, the entity brief and the overview.
- `graph-export.ts`, `graph-export-formats.ts`, `graph-import.ts`: RDF export and import.
- `graph-conflict-reasons.ts` and `graph-enums.ts`: `GRAPH_CONFLICT_REASONS` and the Prisma-enum tuples.

The graph write path (`GraphWriteService`) and every Prisma-backed type stay in the API.

Status: experimental. Moved out of the API DTO files by issue 5.2 (marinoscar/kvox#488) with no change to a field name or a value; every wire shape here is permanent (add, never rename).

## Entry point

`@marinoscar/kvox-contract/graph`. The slice depends on `errors`, `ontology` and `notes`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`, required. The slice imports no other package.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes data shapes, not extension points.

### Desktop

Desktop's main process and renderer both import this slice, so the wire shapes cannot drift between them; install the same version in both. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#who-this-is-for-and-what-you-get).
