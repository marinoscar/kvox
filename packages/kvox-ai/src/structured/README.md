# structured

The strict JSON-schema subset structured output is constrained to, checked locally before anything is sent.

## Purpose and scope

`assertStrictJsonSchema` (throws `StrictSchemaError` naming the JSON path of the first violation), `zodToStrictJsonSchema`, and the limits `MAX_NESTING_DEPTH` and `MAX_TOTAL_PROPERTIES`. The rules are stricter than the vendor in two places so a schema that passes is portable to another provider.

Status: moved from `apps/api/src/ai-port/strict-json-schema.ts` (issue #579).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

`zod`. It imports the `types` slice (`JsonSchema`).

## Configuration

None.

## Extension-point catalog

None.

### Desktop

Pure; usable offline.
