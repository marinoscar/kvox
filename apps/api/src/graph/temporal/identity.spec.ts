import { ONTOLOGY } from '@app/shared/ontology';

import { identityKey, sameIdentityProps, stableStringify, temporalRuleFor } from './index';

// #445: the one "same identity props" rule the planner, dedup and the merge
// fold all share. HAS_ROLE: `title` required (strict), `businessUnit`
// `identity: true` (a null/absent side matches anything).

const HAS_ROLE = temporalRuleFor(ONTOLOGY.relationType('HAS_ROLE')!);
const WORKS_FOR = temporalRuleFor(ONTOLOGY.relationType('WORKS_FOR')!);

describe('identityKey / stableStringify', () => {
  it('trims and case-folds strings and reads absent as null', () => {
    expect(identityKey('  VP ')).toBe(identityKey('vp'));
    expect(identityKey(undefined)).toBe('null');
    expect(identityKey(null)).toBe('null');
    expect(identityKey('')).not.toBe('null');
  });

  it('compares non-strings by key-sorted JSON', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe(stableStringify({ a: [2, { c: 0, d: 1 }], b: 1 }));
    expect(identityKey(3)).not.toBe(identityKey('3'));
  });
});

describe('sameIdentityProps', () => {
  it('distinguishes two different required values — {VP} vs {SVP}', () => {
    expect(sameIdentityProps({ title: 'VP' }, { title: 'SVP' }, HAS_ROLE)).toBe(false);
  });

  it('matches the same required value, case- and space-insensitively', () => {
    expect(sameIdentityProps({ title: 'VP' }, { title: ' vp ' }, HAS_ROLE)).toBe(true);
  });

  it('lets a missing optional identity prop match anything', () => {
    expect(sameIdentityProps({ title: 'VP' }, { title: 'VP', businessUnit: 'Consulting' }, HAS_ROLE)).toBe(true);
    expect(sameIdentityProps({ title: 'VP', businessUnit: null }, { title: 'VP', businessUnit: 'Consulting' }, HAS_ROLE)).toBe(true);
  });

  it('distinguishes two different optional identity values', () => {
    expect(sameIdentityProps({ title: 'VP', businessUnit: 'Sales' }, { title: 'VP', businessUnit: 'Consulting' }, HAS_ROLE)).toBe(false);
  });

  it('treats a required prop absent on one side as null — only equal to null', () => {
    expect(sameIdentityProps({}, { title: 'VP' }, HAS_ROLE)).toBe(false);
    expect(sameIdentityProps({}, { title: null }, HAS_ROLE)).toBe(true);
  });

  it('is always true for a relation with no identity props (WORKS_FOR)', () => {
    expect(sameIdentityProps({ anything: 1 }, {}, WORKS_FOR)).toBe(true);
  });
});
