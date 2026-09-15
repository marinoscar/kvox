# OpenAI stream fixtures (issue #47, epic #45)

Recorded server-sent-event bodies, byte-for-byte in the shape
`openai.provider.ts` parses. They exist for the reason
`../assemblyai/`'s JSON fixtures do: **the vendor's wire format is the thing
most likely to drift between this code being written and it being run in
anger**, and pinning the SHAPE here means a vendor change shows up as a failing
parse test rather than as a silent mis-read in production.

Two of them — `model-list.json` (#78) and `embeddings-response.json` (#183) —
are genuinely JSON, because `GET /models` and `POST /embeddings` genuinely
return JSON documents rather than framed streams. Everything else here is SSE,
and:

They are `.txt` rather than `.json` on purpose — an SSE body is not JSON, it is
a framed stream of JSON payloads, and the framing (`data:` prefixes, blank-line
separators, the `[DONE]` sentinel, frames split across chunk boundaries) is
half of what is being tested. Storing them as JSON would throw away exactly the
part the parser gets wrong.

| File | What it pins |
|---|---|
| `simple-completion.txt` | The ordinary case: several deltas, a `finish_reason: stop`, a usage frame, `[DONE]`. |
| `length-truncated.txt` | `finish_reason: length` — the model ran out of room, which is a completed generation, not a failure. |
| `content-filter.txt` | `finish_reason: content_filter` — a refusal, which `generate` turns into an `AiRefusedError`. |
| `mid-stream-error.txt` | A 200 whose failure arrives *inside* the stream. The case an HTTP status check alone cannot catch. |
| `no-usage.txt` | A gateway that drops `stream_options`, so `done` must fall back to an estimate rather than reporting zero. |
| `embeddings-response.json` | `POST /embeddings` (#183): the envelope, the per-item `index`, the full **1536**-component width and the `usage` block. ⚠ It lists **index 1 before index 0**, on purpose and as the vendor is entitled to: the response array's order is not the contract, the `index` field is, and an implementation that read this file positionally would attach each vector to the wrong text with no error anywhere. The floats are not an embedding of any real text — no fixture can be, without calling a paid API for 1536 meaningless numbers — but every *shape* fact here is the vendor's, and the two vectors are trivially distinguishable (they begin `0.01…` and `0.02…`) precisely so a test can assert which input each one came back for. |
| `model-list.json` | `GET /models` (#78): a flat array carrying **no** context window, **no** output ceiling and **no** display name — which is why `listModels` returns `AiDiscoveredModel` and not `AiModelDescriptor`. It deliberately mixes models this build knows (`gpt-4o`) with ones it does not (`gpt-5-preview`, `o3-mini`), the non-chat entries the vendor really does return (embeddings, Whisper, TTS, DALL·E, moderation, realtime, transcribe), and one **duplicate** id, so the join, the filter and the deduplication are all pinned by the same file. |
