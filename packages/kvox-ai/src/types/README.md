# types

The call and event types every model call and answer is written in.

## Purpose and scope

`KvoxAiCallBase`, `KvoxAiReadiness` and `KvoxAiReason`, `KvoxUsage`, `KvoxTextEvent`, the chat types (`KvoxChatRequest`, `KvoxChatMessage`, `KvoxChatEvent`, `KvoxChatFinishReason`, `KvoxToolDefinition`, `KvoxToolChoice`, `KvoxToolCall`), `KvoxEmbeddingCapability`, `JsonSchema` and `KvoxReasoningEffort`. They are the type half of the former `apps/api/src/ai-port/kvox-ai.ts`; the `KvoxAi` facade interface and its app token were removed when the port was bound to `createKvoxAi` (#579). Types only: no value is exported.

Status: moved (issue #579).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

None of its own. It imports the `features` slice (`KvoxAiFeatureId`).

## Configuration

None.

## Extension-point catalog

None.

### Desktop

Pure types; usable offline with no provider.
