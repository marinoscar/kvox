/**
 * Resolution smoke test for `@app/shared/ontology` (issue #350).
 *
 * The subpath is compiled CommonJS reached through an npm workspace symlink,
 * which is exactly the shape that has broken web builds before (see the
 * `optimizeDeps.include` note in `vite.config.ts`). This proves the web app's
 * test runtime resolves the subpath export and sees its named exports.
 *
 * Web code takes TYPES and small runtime constants from here; forms render
 * from the `GET /api/graph/ontology` payload, never from the registry.
 */
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KINDS, ONTOLOGY_VERSION } from '@app/shared/ontology';
import type { AttributeKind, EffectiveSchemaPayload } from '@app/shared/ontology';

describe('@app/shared/ontology resolution', () => {
  it('exports ONTOLOGY_VERSION as a semver string', () => {
    expect(ONTOLOGY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exports ATTRIBUTE_KINDS as the fixed kind list', () => {
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

  it('carries the payload type a form renders from', () => {
    const kind: AttributeKind = ATTRIBUTE_KINDS[0];
    const payload: EffectiveSchemaPayload = {
      version: ONTOLOGY_VERSION,
      domains: [{ key: 'core', label: 'Core', enabled: true, alwaysOn: true }],
      entityTypes: [],
      relationTypes: [],
    };
    expect(kind).toBe('text');
    expect(payload.domains[0].key).toBe('core');
  });
});
