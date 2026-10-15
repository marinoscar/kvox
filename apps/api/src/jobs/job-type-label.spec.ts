import { RegistryError } from '../common/registry';
import { resetRegistryForTests, withTemporaryEntries } from '../common/registry/testing';
import {
  JOB_TYPE_LABELS,
  jobTypeLabel,
  jobTypeLabelRegistry,
  jobTypeLabels,
  registerJobTypeLabel,
  registerJobTypeLabels,
} from './job-type-label';

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof RegistryError ? err.code : `non-registry:${String(err)}`;
  }
  return undefined;
}

// The registry is process-wide state filled by `kvox.manifest` (imported from
// `test/setup.ts`). Every case below works on a temporary or a reset copy and
// restores what it found.
describe('job-type label registry', () => {
  it('serves the manifest-registered base and domain labels', () => {
    expect(jobTypeLabel('example.echo')).toBe('Example echo');
    expect(jobTypeLabel('note.generate')).toBe('Note generation');
    expect(jobTypeLabel('kg.import')).toBe('Knowledge graph import');
    expect(jobTypeLabel('ask.respond')).toBe('Ask answer');
  });

  it('falls back to the raw type for an unregistered type', () => {
    expect(jobTypeLabel('my-feature.do-the-thing')).toBe('my-feature.do-the-thing');
  });

  it('JOB_TYPE_LABELS is a live read-only view of the registry', async () => {
    expect(JOB_TYPE_LABELS['example.echo']).toBe('Example echo');
    expect(JOB_TYPE_LABELS['nope.nope']).toBeUndefined();
    expect('example.echo' in JOB_TYPE_LABELS).toBe(true);
    expect(Object.keys(JOB_TYPE_LABELS)).toEqual(jobTypeLabelRegistry.ids());
    expect(Object.entries(JOB_TYPE_LABELS)).toEqual(Object.entries(jobTypeLabels()));
    await withTemporaryEntries(jobTypeLabelRegistry, [{ type: 'spec.live', label: 'Live' }], () => {
      expect(JOB_TYPE_LABELS['spec.live']).toBe('Live');
    });
    expect(JOB_TYPE_LABELS['spec.live']).toBeUndefined();
    expect(() => {
      (JOB_TYPE_LABELS as Record<string, string>)['x'] = 'y';
    }).toThrow();
  });

  describe('registration', () => {
    let saved: ReturnType<typeof jobTypeLabelRegistry.list>;

    beforeEach(() => {
      saved = jobTypeLabelRegistry.list();
      resetRegistryForTests(jobTypeLabelRegistry);
    });

    afterEach(() => {
      resetRegistryForTests(jobTypeLabelRegistry);
      jobTypeLabelRegistry.registerAll(saved);
      jobTypeLabelRegistry.freeze();
    });

    it('registers one label and a record, keeping record order', () => {
      registerJobTypeLabel('a.one', 'One');
      registerJobTypeLabels({ 'b.two': 'Two', 'c.three': 'Three' });
      expect(jobTypeLabelRegistry.ids()).toEqual(['a.one', 'b.two', 'c.three']);
      expect(jobTypeLabel('b.two')).toBe('Two');
    });

    it('throws DUPLICATE_ID for a type registered twice and keeps the first label', () => {
      registerJobTypeLabel('a.one', 'One');
      expect(codeOf(() => registerJobTypeLabel('a.one', 'Other'))).toBe('DUPLICATE_ID');
      expect(jobTypeLabel('a.one')).toBe('One');
    });

    it('registerJobTypeLabels is all or nothing', () => {
      registerJobTypeLabel('a.one', 'One');
      expect(codeOf(() => registerJobTypeLabels({ 'b.two': 'Two', 'a.one': 'Dup' }))).toBe('DUPLICATE_ID');
      expect(jobTypeLabelRegistry.ids()).toEqual(['a.one']);
    });

    it.each(['', '   '])('rejects an empty label %p', (label) => {
      expect(codeOf(() => registerJobTypeLabel('a.one', label))).toBe('INVALID_ENTRY');
    });

    it('rejects an invalid type string', () => {
      expect(codeOf(() => registerJobTypeLabel(' bad', 'Bad'))).toBe('INVALID_ID');
    });

    it('throws FROZEN once the registry is frozen', () => {
      registerJobTypeLabel('a.one', 'One');
      jobTypeLabelRegistry.freeze();
      expect(codeOf(() => registerJobTypeLabel('b.two', 'Two'))).toBe('FROZEN');
      expect(jobTypeLabel('a.one')).toBe('One');
    });
  });
});
