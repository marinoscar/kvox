# ontology

The ontology as code: entity and relation types per domain, the registry, the effective schema a user sees, the props validators, the JSON Schema builder and the version migrations.

## Purpose and scope

The ontology as code: entity and relation types per domain, the registry, the effective schema a user sees, the props validators, the JSON Schema builder and the version migrations. Plain Zod schemas, `as const` tuples and inferred types only: no Nest, no `nestjs-zod`, no Node built-in, so it loads in the browser too.

- `define.ts`, `registry.ts`, `types.ts`, `constants.ts`, `domains/{core,work,personal}.ts`: the definitions and the explicit domain list (never self-registered).
- `effective-schema.ts`, `props-schema.ts`, `json-schema.ts`: the per-user effective schema, props validation and the strict-mode JSON Schema builder.
- `version.ts`, `migrations.ts`, `shipped-keys.ts`, `rdf-namespaces.ts`: `ONTOLOGY_VERSION` and its changelog, the migration table, the permanent key set and the RDF prefixes.

Every ontology change bumps `ONTOLOGY_VERSION` and appends a `CHANGELOG` entry ([docs/specs/ontology.md](../../../../docs/specs/ontology.md) section 17). `@app/shared/ontology` re-exports this entry point.

Status: experimental. Moved out of the API DTO files by issue 5.2 (marinoscar/kvox#488) with no change to a field name or a value; every wire shape here is permanent (add, never rename).

## Entry point

`@marinoscar/kvox-contract/ontology`. The slice depends on no other slice. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`, required. The slice imports no other package.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes data shapes, not extension points.
