# chat

The mapping of a chat turn to one provider-adapter request and of its stream events back to `KvoxChatEvent`.

## Purpose and scope

`toPlatformTools` and `toPlatformToolChoice` (tool definitions as strict function tools), `toPlatformInput` (messages as instructions plus input items, full history every call), `fromPlatformEvent`, `createChatMappingState`, `missingToolCalls` and `toolCallIdsOf` (events back, each tool call once), `ReasoningReplayCache` and `replayScope` (the opaque reasoning items a stateless provider needs replayed in front of a tool call), and `clearToolCache`. The prompted tool path (#654), for a model whose `toolCallingMode` is `prompted`: `buildPromptedToolInstructions` (the generic tool block appended to the loop's system prompt), `toPromptedToolInput` (the transcript as plain messages: an assistant tool step as the JSON it would have said, one step's tool results as one user message), `parsePromptedToolAnswer` (fence strip, `JSON.parse`, the shape, the tool names the step may call under its tool choice, each call's arguments against the tool's JSON Schema), `buildPromptedToolRepairInput` (the one repair request's input), `countToolCalls` and `promptedToolCallId` (ids that stay unique across a transcript). Pure: no network, no key, no logger. The calls, the single repair and the error classes are the `port` slice's.

Status: moved from `apps/api/src/ai-port/chat-mapping.ts` (issue #579).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

`zod`, `@marinoscar/platform-ai-providers` (`AiError` and the provider-adapter request and event types). It imports the `types` slice.

## Configuration

None.

## Extension-point catalog

None.

### Desktop

Pure; the provider round trip it maps is the host runtime's.
