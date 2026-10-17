// The testing entry of the notes slice: the conformance suite of the pipeline invariants, the
// exporter kit, the fixtures they and the application's specs use, an in-memory copy of the tables
// the generation pipeline writes, and the `NotesService` test factory. Import it from tests only
// (it loads the optional peers `docx` and `unpdf`).

export * from './export-fixtures.js';
export * from './exporter-conformance.js';
export * from './in-memory-notes-db.js';
export * from './notes-conformance.js';
export * from './notes-service-test-factory.js';
export { WordNoteExporter } from '../export/word.exporter.js';
export * from './document-fixtures.js';
