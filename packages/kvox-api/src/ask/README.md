# ask

The read-only graph agent: saved conversations, one queue job per turn that drives a tool-calling chat over the owner's graph, and an SSE view over the durable answer, as one Nest module a host configures with `AskModule.forRoot`.

## Purpose and scope

What the slice owns: the `ask_conversations` and `ask_messages` tables' services and routes (`GET|POST /api/ask/conversations`, `GET|PATCH|DELETE /api/ask/conversations/{id}`, `POST /api/ask/conversations/{id}/messages`, `GET /api/ask/messages/{id}/stream`); the `ask.respond` job (the loop on `KVOX_AI.chat`, the caps, the answer hold, the citation check); the seven read-only tools (`search`, `get_entity`, `neighbors`, `timeline`, `evidence`, `entity_brief`, `list_commitments`) with their handle registry and sensitivity filter; and `AskUserDataService` for an account-data deletion. What it does not own: the graph it reads (the `graph` slice), search (the `search` slice), the AI provider keys and the model catalogue (the host's `KVOX_AI` adapter), and the wire schemas (`@marinoscar/kvox-contract/ask`). The slice imports no graph write service: every tool is a read.

Status: experimental (issue #497). Every export carries `@stability experimental`.

KVox Desktop runs Ask unchanged: any `KVOX_AI` that passes `describeKvoxPortsConformance` and `describeAskConformance` runs a turn, because the loop uses only `resolveTask`, `capabilities`, `countTokens` and the streaming `chat` (`delta`, `tool_call`, `step_end`, `done`).

### Quick start

```ts
import { GraphModule } from '@marinoscar/kvox-api/graph';
import { NotesModule } from '@marinoscar/kvox-api/notes';
import { SearchModule } from '@marinoscar/kvox-api/search';
import { AskModule } from '@marinoscar/kvox-api/ask';

const search = SearchModule.forRoot();
const notes = NotesModule.forRoot();
const graph = GraphModule.forRoot({ peers: { notes, search } });

@Module({
  imports: [search, notes, graph, AskModule.forRoot({ limits: { maxSteps: 5 }, peers: { graph, notes, search } })],
})
export class DomainModule {}
```

### Data

Works on `ask_conversations` and `ask_messages` (the answer buffer `content`, `tool_calls`, `citations`, the status machine `pending`, `streaming`, `complete`, `failed`). `ask_messages_one_running_turn_uniq_idx` is a partial unique index that exists only in `migration.sql`: it decides the 409 `ask_turn_running` at insert, so the slice never pre-checks. It reads the graph tables, `transcripts` and `notes` (the date of a cited passage) through the structural client `KvoxAskDb`; the application proves its real client satisfies it in `apps/api/test/kvox/prisma-shape.typecheck.ts`.

### Permissions and settings

- Permissions: none of its own. Every route is `graph:read` (asking is a read of one's own graph), owner-only, and a missing and a foreign id are the same 404, never a 403. There is no `ask:*` pair and no `*:read_any`.
- Settings: none of its own. The deployment's `ai` namespace holds the graph switch and the optional input and output spend caps; the `graph` per-user namespace holds the preferences the tools consult.
- Job type (permanent): `ask.respond`, server-only (no node members), `maxRuntimeMs` five minutes, `maxAttempts` 1, priority -10. A provider rate limit before any text defers the job without an attempt, on the asker's own bucket (`aiProviderThrottleKey`); after text was flushed it fails the turn `rate_limit`.
- Audit: deleting a conversation records `ask.conversation_deleted` (counts and ids only) through `KVOX_AUDIT`.

### Security notes

A character written to `ask_messages.content` is never taken back: text a model streams before a tool call in the same step is held and discarded (`AnswerHold`), an invalid citation marker stays in the text and is flagged `valid: false`, and every write is `WHERE status = 'streaming'`, so a deleted conversation (the row cascades away) stops the turn with no orphan write. A `sensitive` PersonFact and personal-type entities and relations never reach the model. The handler logs counts, never a question, an answer, a tool argument or a result, and no key passes through the slice: the host resolves the asker's key per call.

### Conformance suite

`describeAskConformance(name, aiFactory, { describe, it, expect })` from `@marinoscar/kvox-api/ask/testing` runs the real handler over an in-memory copy of the two tables and holds a model binding to the turn's rules: `ask.respond` is server-only with one attempt; text before a tool call is held and discarded; nine model calls end `step_cap` after exactly one `toolChoice: 'none'` call; a 429 before text defers the job on the asker's bucket and resets the row to `pending`; a 429 after text fails `rate_limit`; an invalid citation marker stays and is flagged; a conversation deleted mid-turn leaves no orphan write; and the slice imports no graph write service, no platform package and no generated Prisma client. `aiFactory` returns the model port under test and a way to script its next `chat` calls (`scriptedAiUnderTest()` is the package's own); the package runs it (`test/ask-conformance.spec.ts`) and the web application runs it over its platform AI adapter.

## Entry point

`@marinoscar/kvox-api/ask` and `@marinoscar/kvox-api/ask/testing` for tests and evaluation scripts (the conformance suite, `createScriptedChat`, the in-memory tables, the tool fakes and an `internals` namespace tagged `@internal`). The slice depends on `ports`, `core`, `testing`, `graph`, `notes`, `search` and `transcripts` (`packages/kvox-slices.json`).

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core` and `zod`, which every slice needs, plus `@nestjs/swagger` and `nestjs-zod` (the controllers' OpenAPI decorators and DTO classes) and `rxjs` (the SSE stream). The per-slice data is `packages/kvox-slice-peers.json`.

## Configuration

`AskModule.forRoot(options)` returns a non-global dynamic module. The package reads no environment variable.

| Option | Default | What it does |
|---|---|---|
| `limits.maxSteps` | `8` | Model calls that may request tools; the next call is forced to answer (`step_cap`). May only be lowered. |
| `limits.maxCallsPerStep` | `4` | Tool calls run per step; extras are answered `ok: false` without running. May only be lowered. |
| `limits.softClockMs` | `240000` | Wall clock after which the next call is forced to answer (`time_cap`). May only be lowered. |
| `stream.pollIntervalMs` | `250` | Milliseconds between reads of the answer row. |
| `stream.heartbeatMs` | `25000` | Milliseconds between heartbeat comments. |
| `imports` | none | Extra modules the slice's providers need. |
| `peers` | fresh `GraphModule`, `NotesModule`, `SearchModule` | The very module objects the host imports. |

A limit above today's value, or one that is not a positive integer, throws when `forRoot` is called: a host must not be able to make a turn bill more than the product's own caps.

## Extension-point catalog

| Symbol | What a host does with it |
|---|---|
| `AskModuleOptions` | The options of `AskModule.forRoot`. |
| `AskUserDataService` | Call `deleteAll(userId)` from an account-data deletion; the web edition's planner deletes the rows itself from its model hint. |
| `KvoxAskDb` | The structural database client the slice injects through `KVOX_PRISMA`. |
| `describeAskConformance`, `createScriptedChat` | The conformance kit and the scripted model it and the replay runs use. |
