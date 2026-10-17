# ask

The Ask wire contract: saved conversations, messages with citations and tool calls, and the post-message request and response.

## Purpose and scope

The Ask wire contract: saved conversations, messages with citations and tool calls, and the post-message request and response. Plain Zod schemas, `as const` tuples and inferred types only: no Nest, no `nestjs-zod`, no Node built-in, so it loads in the browser too.

- `ask.ts`: `ASK_*` constants and reasons, the citation, tool call and message schemas, the conversation list and detail.
- `ask-messages.ts`: the post-message body and its response.

`askMessageSchema` is used unchanged by the stream, the eval harness and the web: a field name is permanent (add, never rename).

Status: experimental. Moved out of the API DTO files by issue 5.2 (marinoscar/kvox#488) with no change to a field name or a value; every wire shape here is permanent (add, never rename).

## Entry point

`@marinoscar/kvox-contract/ask`. The slice depends on `errors` and `graph`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`, required. The slice imports no other package.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes data shapes, not extension points.

### Desktop

Desktop's main process and renderer both import this slice, so the wire shapes cannot drift between them; install the same version in both. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#who-this-is-for-and-what-you-get).
