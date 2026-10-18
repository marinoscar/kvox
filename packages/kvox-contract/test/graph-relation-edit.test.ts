import { describe, expect, it } from 'vitest';

import {
  MANUAL_EVIDENCE_SOURCE_IRI,
  createManualRelationSchema,
  evidenceInputSchema,
  evidenceLinkSchema,
} from '../src/graph/index.js';

// The manual relation edit (#586): its body, and the reserved manual-evidence source.

const TO = '33333333-3333-4333-8333-333333333333';

describe('createManualRelationSchema', () => {
  it('accepts a manager, an employer and a role', () => {
    expect(createManualRelationSchema.parse({ type: 'REPORTS_TO', toId: TO })).toEqual({ type: 'REPORTS_TO', toId: TO });
    expect(createManualRelationSchema.parse({ type: 'WORKS_FOR', toId: TO, validFrom: '2026-03-01' }).validFrom).toBe('2026-03-01');
    expect(
      createManualRelationSchema.parse({ type: 'HAS_ROLE', toId: TO, props: { title: ' VP ', businessUnit: 'Finance' } }).props,
    ).toEqual({ title: 'VP', businessUnit: 'Finance' });
  });

  it('refuses another relation type, a role without a title, props on the others, unknown keys and a bad date', () => {
    expect(createManualRelationSchema.safeParse({ type: 'ATTENDED', toId: TO }).success).toBe(false);
    expect(createManualRelationSchema.safeParse({ type: 'HAS_ROLE', toId: TO }).success).toBe(false);
    expect(createManualRelationSchema.safeParse({ type: 'REPORTS_TO', toId: TO, props: { title: 'x' } }).success).toBe(false);
    expect(createManualRelationSchema.safeParse({ type: 'REPORTS_TO', toId: TO, evidence: [] }).success).toBe(false);
    expect(createManualRelationSchema.safeParse({ type: 'REPORTS_TO', toId: TO, validFrom: '2026-02-30' }).success).toBe(false);
    expect(createManualRelationSchema.safeParse({ type: 'REPORTS_TO', toId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('the reserved manual-evidence source', () => {
  it('can never be sent as wire evidence (a proposal item, an import)', () => {
    const result = evidenceInputSchema.safeParse({ quote: 'Set by hand: A reports to B', sourceIri: MANUAL_EVIDENCE_SOURCE_IRI });
    expect(result.success).toBe(false);
    // An anchorless row was never accepted either.
    expect(evidenceInputSchema.safeParse({ quote: 'no anchor' }).success).toBe(false);
    expect(evidenceInputSchema.safeParse({ quote: 'x', sourceIri: 'https://example.test/node' }).success).toBe(true);
  });

  it('is an evidence link of source kind manual', () => {
    const link = {
      id: '11111111-1111-4111-8111-111111111111',
      subjectKind: 'relation',
      subjectId: TO,
      quote: 'Set by hand: A reports to B',
      createdAt: '2026-10-17T00:00:00.000Z',
      source: { kind: 'manual', available: true, href: null },
    };
    expect(evidenceLinkSchema.parse(link)).toEqual(link);
  });
});
