# features

The AI feature ids this product registers, and the task each one runs under.

## Purpose and scope

`KVOX_AI_FEATURES` and `KvoxAiFeatureId` (one id per AI call site, permanent: it rides on every usage row), `KVOX_FEATURE_TASK` (the connected-knowledge task a feature is routed through, or `null`), `KVOX_EMBEDDING_FEATURES` and `isKvoxAiFeature`.

Status: moved from `apps/api/src/ai-port/features.ts` (issue #579, PR 1).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

None of its own. It imports the `tasks` slice (`AiTaskKey`).

## Configuration

None.

## Extension-point catalog

None.

### Desktop

Pure constants; usable offline.
