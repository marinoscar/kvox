// Display labels for the Ask agent's job types (issue #460).
//
// Declared beside the module that owns the types and REGISTERED from
// `src/kvox.manifest.ts`, so the base `jobs/` folder names no domain job type.
// Keys are permanent `Job.type` values; an unlabelled type still renders as
// itself (see `jobs/job-type-label.ts`).

export const ASK_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  // #378, epic #348 — one read-only graph-agent answer, on the asker's own AI key.
  'ask.respond': 'Ask answer',
};
