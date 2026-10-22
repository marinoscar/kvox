import { describe, expect, it } from 'vitest';
import { computeEffectiveSchema, toEffectiveSchemaPayload, validateProps } from '../../src/ontology/index.js';

// Stakeholder and market relations (ontology 1.3.0, #663).

const KEYS = ['INVOLVED_IN', 'USES', 'OFFERED_BY', 'CUSTOMER_OF', 'PARTNER_OF', 'COMPETITOR_OF', 'CONCERNS', 'KNOWS_ABOUT'];
const on = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [] });
const rel = (k: string) => toEffectiveSchemaPayload(on).relationTypes.find((r) => r.key === k)!;
const write = (k: string, props: unknown) => validateProps(on, k, props, { relation: true });

describe('stakeholder and market relations (#663)', () => {
  it('declares all eight with the endpoints of the issue', () => {
    expect(rel('INVOLVED_IN')).toMatchObject({ from: ['Person'], to: ['Project'], temporal: true, exclusive: 'none' });
    expect(rel('USES')).toMatchObject({ from: ['Organization', 'Project'], to: ['Product'], temporal: true });
    expect(rel('OFFERED_BY')).toMatchObject({ from: ['Product'], to: ['Organization'], exclusive: 'soft', exclusiveScope: 'from' });
    expect(rel('CUSTOMER_OF')).toMatchObject({ from: ['Organization'], to: ['Organization'], temporal: true });
    expect(rel('CONCERNS')).toMatchObject({ from: ['Project'], to: ['Product', 'Topic'], temporal: false });
    expect(rel('KNOWS_ABOUT')).toMatchObject({ from: ['Person'], to: ['Topic', 'Product'], temporal: false });
  });

  it('marks only PARTNER_OF and COMPETITOR_OF symmetric', () => {
    const sym = KEYS.filter((k) => rel(k).symmetric === true);
    expect(sym).toEqual(['PARTNER_OF', 'COMPETITOR_OF']);
  });

  it('is hidden with the work domain', () => {
    const off = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    for (const k of KEYS) expect(off.relationType(k)).toBeUndefined();
  });

  it('validates INVOLVED_IN role and stance, stance optional', () => {
    expect(write('INVOLVED_IN', { role: 'approver', stance: 'skeptical' }).ok).toBe(true);
    expect(write('INVOLVED_IN', { role: 'approver' }).ok).toBe(true);
    expect(write('INVOLVED_IN', { role: 'boss' }).ok).toBe(false);
    expect(write('INVOLVED_IN', { role: 'lead', stance: 'angry' }).ok).toBe(false);
  });

  it('validates USES stage and KNOWS_ABOUT level', () => {
    expect(write('USES', { stage: 'piloting' }).ok).toBe(true);
    expect(write('USES', {}).ok).toBe(true);
    expect(write('USES', { stage: 'testing' }).ok).toBe(false);
    expect(write('KNOWS_ABOUT', { level: 'expert' }).ok).toBe(true);
    expect(write('KNOWS_ABOUT', { level: 'guru' }).ok).toBe(false);
  });

  it('closes a USES stage change: soft, scoped to the pair, stage is identity', () => {
    expect(rel('USES')).toMatchObject({ exclusive: 'soft', exclusiveScope: 'from_to' });
    expect(rel('USES').props.find((p) => p.key === 'stage')).toMatchObject({ identity: true });
  });
});
