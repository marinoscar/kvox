---
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-eval": minor
---

Graph extraction reads a document or record that describes several meetings (#780). When a note was made from an uploaded document and has no transcript behind it, extraction may propose Meetings: each with its own `occurredOn` and `meetingKind`, its organizer (ORGANIZED) and its attendees (ATTENDED with `attendance`), all cited. Two or more proposed meetings replace the system Meeting, and each fact is attached to the meeting it was cited under; fewer than two keep the system Meeting, so a single-meeting note and every transcript extract exactly as before, with an unchanged prompt. Chunked extraction merges a meeting restated in two parts by its normalised title and date.

A document-origin note also gets one system Document row (the note's title, `preparedOn` when the date is stated), cited like the system Meeting, with RECORDED_IN from each meeting. `ExtractionInput` and `LoadExtractionInput` accept an optional `selfEntityId` (default null): when set, the owner is offered as a known entity and the Document gets PREPARED_FOR to them. `ExtractionInput.sourceType` carries the note's source type; the loader fills it. The evaluation harness gains a long-record fixture and the pass criteria for it.
