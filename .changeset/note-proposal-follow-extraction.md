---
"@marinoscar/kvox-web": minor
---

Follow an automatic graph extraction on the note page (#616). The `ProposalActions` slot of `NotePage` now receives the note's `status` and `updatedAt` (`NoteProposalActionsProps`), and `useGraphProposal` gains an `awaitUntil` option that keeps re-reading a note's proposal while it is still `null`, until that time (paused in a hidden tab). `GraphNotePageProvider` uses both: when the note turns `ready`, or the page opens just after it did, it looks for the proposal the server's auto-extraction creates for `NOTE_EXTRACTION_FOLLOW_MS` (30 s, newly exported from the graph headless entry), so the review sheet shows the extraction instead of "Nothing sent to your graph from this note yet".
