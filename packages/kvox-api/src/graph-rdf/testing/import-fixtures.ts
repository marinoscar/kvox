import { Readable } from 'node:stream';

import { kvNamespace } from '@marinoscar/kvox-contract/ontology';

import { DEFAULT_KVOX_BRAND } from '../../core/index.js';

import { IMPORT_FIXTURE_TEXT } from './import-fixture-data.js';
import { FIXTURE_NS } from './rdf-fixtures.js';

// =============================================================================
// Import fixtures (#387)
// =============================================================================
//
// The `import-*` files under `fixtures/` are written against the fixture
// namespace (`https://fixture.app/ns#`), never this deployment's own — a file
// spelling the product's namespace would have to change on every rebrand.
// `kg.import` reads the application namespace (`kvNamespace(brand.appSlug)`), so
// the loader substitutes it: the fixture on disk stays product-neutral, the
// bytes the handler parses are exactly what an export of this deployment
// would carry.
// =============================================================================

/** The namespace of the default brand, the one the slice's own specs read. */
export const APP_NS = kvNamespace(DEFAULT_KVOX_BRAND.appSlug);

export type ImportFixture = 'import-valid.ttl' | 'import-invalid.ttl' | 'import-unknown-prop.ttl' | 'import-newer-major.ttl' | 'import-crm.jsonld';

/** A fixture's text with the fixture namespace replaced by this deployment's. */
export function importFixture(name: ImportFixture, ns: string = APP_NS): string {
  return IMPORT_FIXTURE_TEXT[name].split(FIXTURE_NS).join(ns);
}

/** The same, as the stream `parseRdf` reads. */
export function importFixtureStream(name: ImportFixture, ns: string = APP_NS): Readable {
  return Readable.from([Buffer.from(importFixture(name, ns), 'utf8')]);
}
