// The host-neutral half of the notes slice: the API clients, the hooks over
// them and the pure helpers other screens share. No component, no `@mui/*`, no
// router, and no `@tiptap/*` or `react-markdown` (those are the `ui` entry's
// optional peers).

// The API clients. Each call takes the `KvoxWebHost` first.
export * from './clients/notes.js';
export * from './clients/noteTemplates.js';
export * from './clients/noteExports.js';
export * from './clients/noteGenerationStream.js';

// The hooks.
export * from './hooks/useNotes.js';
export * from './hooks/useNoteTemplates.js';
export * from './hooks/useNoteGenerationContext.js';
export * from './hooks/useTemplatePreview.js';

// Pure helpers other screens use.
export * from './utils/noteSource.js';
