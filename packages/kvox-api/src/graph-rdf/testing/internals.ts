// The slice's internals that a host's integration specs and evaluation scripts reach for. Reached
// through the `internals` namespace of the testing entry; not part of the documented surface.

export { buildImportVocabulary } from '../import/import-vocabulary.js';
export { parseTurtleText } from '../import/rdf-parse.js';
export { ChildProcessShaclEngine, shaclModuleUrl } from '../import/shacl-engine.js';
export { assertionShapeIri, shapeIri } from '../rdf/iris.js';
export { generateShacl } from '../rdf/shacl-generator.js';

// The fixtures.
export * from './import-fixture-data.js';
export * from './import-fixtures.js';
export * from './export-fixture.js';
export * from './rdf-fixtures.js';
