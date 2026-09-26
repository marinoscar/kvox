import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KINDS, ONTOLOGY_VERSION } from '@app/shared/ontology';

// Resolution smoke test (issue #350): `@app/shared/ontology` must resolve and
// execute under Vitest exactly as it does under Jest and plain Node — this is
// the third of the three runtimes the package's build/consumption strategy
// promises (`apps/web/vite.config.ts`'s `optimizeDeps.include` is the other
// half of that promise for `npm run dev`).

describe('@app/shared/ontology resolves under Vitest', () => {
  it('exposes ONTOLOGY_VERSION as a semver string', () => {
    expect(typeof ONTOLOGY_VERSION).toBe('string');
    expect(ONTOLOGY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exposes ATTRIBUTE_KINDS as the closed, non-empty tuple of attribute kinds', () => {
    expect(Array.isArray(ATTRIBUTE_KINDS)).toBe(true);
    expect(ATTRIBUTE_KINDS.length).toBeGreaterThan(0);
    expect(ATTRIBUTE_KINDS).toEqual([
      'text',
      'number',
      'date',
      'boolean',
      'select',
      'multi_select',
      'url',
      'entity_ref',
    ]);
  });
});
