// Display labels for the note pipeline's job types (issue #460).
//
// Declared beside the module that owns the types and REGISTERED from
// `src/kvox.manifest.ts`, so the base `jobs/` folder names no domain job type.
// Keys are permanent `Job.type` values; an unlabelled type still renders as
// itself (see `jobs/job-type-label.ts`).

export const NOTES_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  // The note pipeline (#49, epic #45). All five originally sat here ahead of
  // their handlers — a label is a display string, not a registration, so having
  // one ready costs nothing while a missing one shows an operator a raw dotted
  // type the moment its type first appears. All five are registered today:
  // `note.generate` (#49), `note.source.extract` (#51), `note.export` (#54),
  // `note.purge` and `notes.housekeeping` (#53).
  'note.generate': 'Note generation',
  'note.source.extract': 'Document text extraction',
  'note.export': 'Note export',
  'note.purge': 'Note purge',
  'notes.housekeeping': 'Note housekeeping',
  // Retroactive titling (#184, epic #163), registered by its own issue. "Note
  // retitle" and not "Note titling": a dashboard filtered by this type during a
  // library sweep is showing one row per note being RE-named, and the operator
  // reading it wants the verb that says these notes already had a title.
  'note.retitle': 'Note retitle',
};
