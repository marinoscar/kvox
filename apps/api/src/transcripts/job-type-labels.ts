// Display labels for the transcript pipeline's job types (issue #460).
//
// Declared beside the module that owns the types and REGISTERED from
// `src/kvox.manifest.ts`, so the base `jobs/` folder names no domain job type.
// Keys are permanent `Job.type` values; an unlabelled type still renders as
// itself (see `jobs/job-type-label.ts`).

export const TRANSCRIPTS_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  // The transcript pipeline (#25, epic #19). `media.audio.transcode` and
  // `transcript.snapshot` are labelled here too even though issues #26 and #27
  // register their handlers: a label is a display string, not a registration,
  // and having it ready costs nothing while a missing one shows an operator a
  // raw dotted type in the admin list.
  'media.audio.transcode': 'Audio transcode',
  'transcription.submit': 'Transcription submit',
  'transcription.poll': 'Transcription poll',
  'transcription.ingest': 'Transcription ingest',
  'transcript.snapshot': 'Transcript snapshot',
  'transcript.export': 'Transcript export',
  'transcript.purge': 'Transcript purge',
  'transcripts.housekeeping': 'Transcript housekeeping',
  // AI name correction (#328/#330, epic #326). Spends the requesting user's
  // own AI key, like `note.generate` — the label says what it checks, not how.
  'transcript.name_check': 'Transcript name check',
};
