# OpenAI stream fixtures (issue #47, epic #45)

Recorded server-sent-event bodies, byte-for-byte in the shape
`openai.provider.ts` parses. They exist for the reason
`../assemblyai/`'s JSON fixtures do: **the vendor's wire format is the thing
most likely to drift between this code being written and it being run in
anger**, and pinning the SHAPE here means a vendor change shows up as a failing
parse test rather than as a silent mis-read in production.

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
