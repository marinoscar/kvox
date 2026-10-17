# chat

The mapping of a chat turn to one provider-adapter request and of its stream events back to `KvoxChatEvent`.

## Purpose and scope

`toPlatformTools` and `toPlatformToolChoice` (tool definitions as strict function tools), `toPlatformInput` (messages as instructions plus input items, full history every call), `fromPlatformEvent`, `createChatMappingState`, `missingToolCalls` and `toolCallIdsOf` (events back, each tool call once), `ReasoningReplayCache` and `replayScope` (the opaque reasoning items a stateless provider needs replayed in front of a tool call), and `clearToolCache`. Pure: no network, no key, no logger.

Status: moved from `apps/api/src/ai-port/chat-mapping.ts` (issue #579, PR 1).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

`zod`, `@marinoscar/platform-api` (only the subpath `@marinoscar/platform-api/ai`: `AiError` and the provider-adapter request and event types). It imports the `types` slice.

## Configuration

None.

## Extension-point catalog

None.

### Desktop

Pure; the provider round trip it maps is the host runtime's.
