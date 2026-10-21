# embedding

The embedding catalog: the one model the product embeds with, and its limits.

## Purpose and scope

`EMBEDDING_DIMENSIONS` (1536, the other half of the `vector(1536)` columns: a contract, not a default), `KVOX_EMBEDDING` and `KVOX_EMBEDDING_PROVIDER` (model id, input ceiling, batch size of 128), the `KvoxEmbeddingModel` entry type a host chooses with `createKvoxAi({ embedding })`, and `KVOX_LOCAL_EMBEDDING` (the 384-wide on-device bge-small-en-v1.5-int8, zero-padded to 1536 by the port). Changing the width or the model id is a migration and a full re-index, never an edit.

Status: moved from `apps/api/src/ai-port/embedding-catalog.ts` (issue #579).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

None of its own. It imports the `types` slice (`KvoxEmbeddingCapability`).

## Configuration

None.

## Extension-point catalog

None.

### Desktop

The constants are offline; embedding itself needs a provider through the host runtime's `embed`.
