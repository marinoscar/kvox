# graph-rdf

The graph as RDF: the OWL ontology and SHACL shapes the ontology generates, the data export (`kg.export`: Turtle, JSON-LD, N-Quads) and the import (`kg.import`: validate, map onto a proposal, review), as one Nest module a host configures with `GraphRdfModule.forRoot`.

## Purpose and scope

What the slice owns: `GET /api/graph/ontology.owl` and `.shacl.ttl` (deterministic, ETag-cached); the export routes and the `kg.export` handler (streams the serialised graph into the object store; a sensitive PersonFact and its evidence are never written); the daily expiry sweep of old exports; the import routes (`POST /api/graph/imports`, the attribute-offer routes) and the `kg.import` handler (parse with `n3`/`jsonld`, version negotiation, SHACL validation in a child process, mapping onto a draft proposal that runs every proposal stage). What it does not own: the core graph and the proposal pipeline (the `graph` and `graph-extraction` slices), the tables, and the object store. Only `rdf-parse.ts`, `serializers.ts` and `shacl-engine.ts` touch an RDF library.

Status: experimental (issue #496). Every export carries `@stability experimental`.

### Quick start

```ts
import { GraphRdfModule } from '@marinoscar/kvox-api/graph-rdf';

@Module({
  imports: [
    graph,
    extraction,
    GraphRdfModule.forRoot({ peers: { graph, extraction, transcripts, notes }, maxImportBytes: 20 * 1024 * 1024 }),
  ],
})
export class DomainModule {}
```

### Data

Works on `kg_exports` and the proposal tables, and reads the core graph tables with keyset pagination (raw SQL). Exports and uploaded import files are objects of the object store port, owned by the `graph` module.

### Permissions and settings

- Permissions: `graph:read` and `graph:write` from the `graph` slice. Settings: none. Secrets: none.
- Job types (permanent, server-only, spend no AI key): `kg.export` (ten minutes, three attempts) and `kg.import` (thirty minutes, ONE attempt: a half-applied import is not safe to repeat).

### Security notes

A `sensitive` PersonFact never leaves the deployment: the export filters it and its evidence quote, and the import skips any item the file marks sensitive. The import never reads a remote context: JSON-LD contexts come from the bundled documents and a remote one is refused. SHACL validation runs in a child `node` process with a timeout and a memory ceiling, and its report never carries file content. The expiry cron only enqueues.

### Conformance suite

`describeGraphRdfConformance(name, build, { describe, it, expect })` from `@marinoscar/kvox-api/graph-rdf/testing` holds a binding to the invariants: `kg.export` and `kg.import` are registered, server-only and carry their pinned profile, an export validates against the generated SHACL shapes in Turtle and JSON-LD, is byte-identical across runs, and maps back onto proposal rows with nothing skipped as sensitive. The package runs it (`test/graph-module.spec.ts`); the web application runs it over its own binding.

## Entry point

`@marinoscar/kvox-api/graph-rdf` and `@marinoscar/kvox-api/graph-rdf/testing` for tests (the conformance suite and an `internals` namespace tagged `@internal`: the RDF fixtures and generators). The slice depends on `ports`, `core`, `testing`, `graph`, `graph-extraction`, `transcripts` and `notes` (`packages/kvox-slices.json`).

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core` and `zod`, which every slice needs, plus `@nestjs/swagger`, `nestjs-zod`, `@nestjs/schedule` (the expiry cron; loaded only when `schedules` is not `false`), `fastify` (the multipart request type of the import route) and the RDF libraries `n3`, `jsonld` and `rdf-validate-shacl`. `rdf-validate-shacl` is ESM-only and runs in a child process; the module refuses to start, naming it, when the import is on and it cannot be resolved.

## Configuration

`GraphRdfModule.forRoot(options)` returns a non-global dynamic module. The package reads no environment variable.

| Option | Default | What it does |
|---|---|---|
| `export` | `true` | Offer the RDF data export (`kg.export`). |
| `import` | `true` | Offer the RDF import (`kg.import`); needs `rdf-validate-shacl`. |
| `maxImportBytes` | `20971520` (20 MiB) | The largest uploaded file. |
| `schedules` | `true` | `false` registers no `@nestjs/schedule` task; the host calls `KgExportExpiryEnqueuer.enqueue()` on its own timer. |
| `imports` | none | Extra modules the slice's providers need. |
| `peers` | fresh modules | The very module objects the host imports (`graph`, `extraction`, `transcripts`, `notes`). |

## Extension-point catalog

| Symbol | What a host does with it |
|---|---|
| `GraphRdfModuleOptions` | The options of `GraphRdfModule.forRoot`. |
| `ShaclEngine` | The validation engine the import uses; a test injects a double. |
| `describeGraphRdfConformance` | The conformance kit and the binding it is run against. |

### Desktop

RDF export and import work offline; they need the `n3`, `jsonld` and `rdf-validate-shacl` peers, and the housekeeping cron becomes a call to `KgExportExpiryEnqueuer.enqueue()`. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#install).
