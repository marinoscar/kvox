import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { APP_SLUG } from '@app/shared';
import { kvNamespace } from '@app/shared/ontology';

import { FIXTURE_NS } from './rdf-fixtures';

// =============================================================================
// Import fixtures (#387)
// =============================================================================
//
// The `import-*` files under `fixtures/` are written against the fixture
// namespace (`https://fixture.app/ns#`), never this deployment's own — a file
// spelling the product's namespace would have to change on every rebrand.
// `kg.import` reads the application namespace (`kvNamespace(APP_SLUG)`), so
// the loader substitutes it: the fixture on disk stays product-neutral, the
// bytes the handler parses are exactly what an export of this deployment
// would carry.
// =============================================================================

export const APP_NS = kvNamespace(APP_SLUG);

export type ImportFixture = 'import-valid.ttl' | 'import-invalid.ttl' | 'import-unknown-prop.ttl' | 'import-newer-major.ttl' | 'import-crm.jsonld';

/** A fixture's text with the fixture namespace replaced by this deployment's. */
export function importFixture(name: ImportFixture, ns: string = APP_NS): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8').split(FIXTURE_NS).join(ns);
}

/** The same, as the stream `parseRdf` reads. */
export function importFixtureStream(name: ImportFixture, ns: string = APP_NS): Readable {
  return Readable.from([Buffer.from(importFixture(name, ns), 'utf8')]);
}
