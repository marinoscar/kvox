# parity

The harness-parity scenario: the proof that two bindings of the model port send a provider the same request.

## Purpose and scope

For the same input, the web edition's `KVOX_AI` and KVox Desktop's must build byte-identical provider requests: the system prompt, the user prompt or input, the strict JSON Schema, the tool definitions, the model, the reasoning effort and the output ceiling. If the requests match, the harness is the same. `runParityScenario(ai, { fixtures?, questions?, script? })` drives the product's own code through any `KvoxAiPort`, with no copied prompt:

- `notes.generate`: the notes slice's `assemblePrompt` over the first built-in template and the meeting's transcript, sized with the slice's `budgetFromTarget`, then `generateText`.
- `graph.extract`: `runExtraction` of the `kg` slice (the graph-extraction slice's prompt, output schema and validator).
- `graph.adjudicate`: the graph-extraction slice's `AdjudicationService`, over pairs of an extracted entity and a known entity of its type.
- `ask.respond`: the Ask slice's `AskRespondHandler` over `createInMemoryAskDb`, the real toolset definitions and a stub tool run; each question makes a `search` call, then answers over its result.

`createParityScript()` is the scripted provider: a pure function of the request (plus the meeting `focus(id)` the scenario announces), so the SAME script answers behind a binding's adapter or fake platform client. Its extraction answer is the meeting's gold labels. `parityModelState()` / `parityTaskModelSource()` are the task-model state both bindings are built from; the tasks run on different models and efforts on purpose, so a binding that ignored `ai.taskModels` fails. `loadParitySnapshot(name)` reads the committed `parity/requests.<fixture>.json` (`m01`..`m10`) and `parity/requests.ask.json`, at the package root and in `files`, so another repository can compare its own binding to them.

Who runs it: `packages/kvox-eval/test/parity.spec.ts` (direct runtime over a recording adapter, from `@marinoscar/kvox-ai/testing`) and `apps/api/test/kvox/ai-parity.spec.ts` (the real `PlatformAiRuntime` and `PlatformTaskModelSource` over a scripted `AiService`). Both compare with the same files. `KVOX_EVAL_UPDATE_PARITY=1` makes the package spec rewrite them; read the diff, it is the change in what every host sends.

Status: issue #580, part 2.

## Entry point

`@marinoscar/kvox-eval/parity` (not re-exported by the package root: it loads the Ask and graph-extraction testing code).

## Peer dependencies

`@marinoscar/kvox-ai` (`/testing`: the recorders), `@marinoscar/kvox-api` (`/notes`, `/core`, `/graph`, `/graph-extraction`, `/ask`, `/ask/testing`, `/graph-extraction/testing`, `/ports`), `@marinoscar/kvox-contract` (`/ontology`) and `@marinoscar/platform-api` (only `/ai`, types). It imports the `fixtures` and `kg` slices.

## Configuration

`KVOX_EVAL_UPDATE_PARITY=1` (read by the package spec, not by this slice). No key and no network.

## Extension-point catalog

None.
