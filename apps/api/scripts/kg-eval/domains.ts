// =============================================================================
// Which ontology domains a golden fixture is extracted and validated against
// (issue #383). PURE.
// =============================================================================
//
// Every fixture is `core ∪ work` — the default a user who never touched the
// setting has. A fixture tagged `personal` is the story of a user who turned
// the `personal` domain on (docs/specs/ontology.md §17.2, §16 P6), so it is
// read against `core ∪ work ∪ personal`: its labels may use Interest, Trip,
// Milestone and the personal relations, and an extraction run over it is
// offered them. Keeping the default fixtures on `core ∪ work` is what proves a
// user who never enables `personal` sees no personal type anywhere.
// =============================================================================

import type { DomainKey } from '@app/shared/ontology';

import type { GoldenFixture } from './fixture-schema';

/** The tag that marks a fixture as written for a user with `personal` enabled. */
export const PERSONAL_FIXTURE_TAG = 'personal';

export function fixtureDomains(fixture: Pick<GoldenFixture, 'tags'>): DomainKey[] {
  return fixture.tags.includes(PERSONAL_FIXTURE_TAG) ? ['core', 'work', 'personal'] : ['core', 'work'];
}
