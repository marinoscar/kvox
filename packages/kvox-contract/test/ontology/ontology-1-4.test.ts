import { describe, expect, it } from 'vitest';
import {
  CHANGELOG,
  ONTOLOGY_VERSION,
  SHIPPED_KEYS,
  computeEffectiveSchema,
  toEffectiveSchemaPayload,
  validateProps,
} from '../../src/ontology/index.js';

// Ontology 1.4.0 (#776): Opportunity, Document, Meeting and Claim attributes, ORGANIZED,
// ATTENDED.attendance, PART_OF between organizations, INVOLVED_IN to an Opportunity.

const OPPORTUNITY_RELATIONS = ['WITH_CLIENT', 'PURSUED_BY', 'COMPETING_FOR'];

const both = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [] });
const coreOnly = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
const rel = (k: string) => toEffectiveSchemaPayload(both).relationTypes.find((r) => r.key === k)!;
const writeRel = (k: string, props: unknown) => validateProps(both, k, props, { relation: true });
const writeEntity = (k: string, props: unknown) => validateProps(both, k, props);

describe('ontology 1.4.0 (#776)', () => {
  it('bumps the version with one changelog entry and appends the shipped keys', () => {
    expect(ONTOLOGY_VERSION).toBe('1.4.0');
    expect(CHANGELOG.filter((e) => e.version === '1.4.0')).toHaveLength(1);
    expect(CHANGELOG[CHANGELOG.length - 1].version).toBe(ONTOLOGY_VERSION);
    for (const key of [
      'Opportunity', 'Opportunity.stage', 'Opportunity.valueText', 'Opportunity.confidence', 'Opportunity.timing',
      'WITH_CLIENT', 'PURSUED_BY', 'COMPETING_FOR', 'ORGANIZED', 'ATTENDED.attendance', 'Meeting.occurredOn',
      'Meeting.meetingKind', 'Claim.claimKind', 'Claim.value', 'Claim.unit', 'USES.scale', 'Document',
      'Document.title', 'Document.preparedOn', 'Document.classification', 'RECORDED_IN', 'PREPARED_FOR',
    ]) {
      expect(SHIPPED_KEYS, key).toContain(key);
    }
  });

  describe('work domain disabled', () => {
    it('hides Opportunity and every relation that names it', () => {
      expect(coreOnly.entityType('Opportunity')).toBeUndefined();
      for (const k of [...OPPORTUNITY_RELATIONS, 'ORGANIZED', 'CONCERNS', 'INVOLVED_IN']) {
        expect(coreOnly.relationType(k), k).toBeUndefined();
      }
      const text = JSON.stringify(toEffectiveSchemaPayload(coreOnly));
      expect(text).not.toContain('Opportunity');
      expect(text).not.toContain('ATTENDED');
    });

    it('keeps the always-on Document and its relations', () => {
      expect(coreOnly.entityType('Document')).toMatchObject({ domain: 'core', extractable: false, alignment: 'schema:DigitalDocument' });
      expect(coreOnly.relationType('RECORDED_IN')).toMatchObject({ from: ['Meeting'], to: ['Document'], extractable: false });
      expect(coreOnly.relationType('PREPARED_FOR')).toMatchObject({ from: ['Document'], to: ['Person'], extractable: false });
    });

    it('does not offer Opportunity as a Claim subject or ABOUT target', () => {
      expect(coreOnly.entityType('Claim')?.subjectTypes).not.toContain('Opportunity');
      expect(coreOnly.relationType('ABOUT')?.to).not.toContain('Opportunity');
    });
  });

  describe('Opportunity', () => {
    it('is a work entity type with four extractable attributes', () => {
      const t = both.entityType('Opportunity')!;
      expect(t).toMatchObject({ domain: 'work', storage: 'entity', extractable: true });
      expect(t.attributes.map((a) => a.key)).toEqual(['stage', 'valueText', 'confidence', 'timing']);
      expect(t.attributes.every((a) => a.extractable)).toBe(true);
    });

    it('validates stage and confidence choices', () => {
      expect(writeEntity('Opportunity', { stage: 'shaping', valueText: 'a multi-year deal', confidence: 'med', timing: 'end of Q3' }).ok).toBe(true);
      expect(writeEntity('Opportunity', { stage: 'closed' }).ok).toBe(false);
      expect(writeEntity('Opportunity', { confidence: 'medium' }).ok).toBe(false);
    });

    it('declares the client and rival relations with the endpoints of the issue', () => {
      expect(rel('WITH_CLIENT')).toMatchObject({ from: ['Opportunity'], to: ['Organization'], temporal: true, exclusive: 'soft', exclusiveScope: 'from' });
      expect(rel('PURSUED_BY')).toMatchObject({ from: ['Opportunity'], to: ['Organization'], temporal: true, exclusive: 'none' });
      expect(rel('COMPETING_FOR')).toMatchObject({ from: ['Organization'], to: ['Opportunity'], temporal: true, exclusive: 'none' });
    });

    it('widens CONCERNS to Opportunity -> Project, Product, Topic and leaves Project -> Project out', () => {
      expect(rel('CONCERNS').allowedPairs).toEqual([
        ['Project', 'Product'],
        ['Project', 'Topic'],
        ['Opportunity', 'Project'],
        ['Opportunity', 'Product'],
        ['Opportunity', 'Topic'],
      ]);
    });

    it('lets a Claim be about an Opportunity', () => {
      expect(both.entityType('Claim')?.subjectTypes).toContain('Opportunity');
    });
  });

  describe('relations', () => {
    it('INVOLVED_IN also reaches an Opportunity and the role gains the sales roles', () => {
      expect(rel('INVOLVED_IN').to).toEqual(['Project', 'Opportunity']);
      for (const role of ['decision_maker', 'influencer', 'evaluator', 'account_lead']) {
        expect(writeRel('INVOLVED_IN', { role }).ok, role).toBe(true);
      }
      expect(writeRel('INVOLVED_IN', { role: 'sponsor' }).ok).toBe(true);
    });

    it('ATTENDED.attendance is optional and closed', () => {
      expect(rel('ATTENDED').props.map((p) => p.key)).toEqual(['attendance']);
      expect(writeRel('ATTENDED', {}).ok).toBe(true);
      for (const attendance of ['attended', 'invited', 'copied']) expect(writeRel('ATTENDED', { attendance }).ok).toBe(true);
      expect(writeRel('ATTENDED', { attendance: 'absent' }).ok).toBe(false);
    });

    it('ORGANIZED is a non-temporal extractable Person -> Meeting edge', () => {
      expect(rel('ORGANIZED')).toMatchObject({ from: ['Person'], to: ['Meeting'], temporal: false, extractable: true, representation: { kind: 'edge' } });
    });

    it('PART_OF allows Organization -> Organization only as an explicit pair', () => {
      const partOf = rel('PART_OF');
      expect(partOf.allowedPairs).toContainEqual(['Organization', 'Organization']);
      expect(partOf.allowedPairs).not.toContainEqual(['Organization', 'Project']);
    });

    it('USES.scale is free text', () => {
      expect(writeRel('USES', { stage: 'adopted', scale: '120 seats' }).ok).toBe(true);
    });
  });

  describe('Meeting and Claim', () => {
    it('Meeting stays non-extractable by default and gains occurredOn and meetingKind', () => {
      const m = both.entityType('Meeting')!;
      expect(m.extractable).toBe(false);
      expect(m.attributes.map((a) => a.key)).toEqual(expect.arrayContaining(['occurredOn', 'meetingKind']));
      expect(writeEntity('Meeting', { occurredOn: '2026-03-04', meetingKind: 'client' }).ok).toBe(true);
      expect(writeEntity('Meeting', { meetingKind: 'board' }).ok).toBe(false);
    });

    it('Claim gains claimKind, value and unit', () => {
      expect(writeEntity('Claim', { claimKind: 'buying_signal', value: '20%', unit: 'percent' }).ok).toBe(true);
      expect(writeEntity('Claim', { claimKind: 'rumour' }).ok).toBe(false);
    });
  });
});
