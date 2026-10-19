/**
 * The first-run journey as data (`home/headless`): what is offered, to whom, in which
 * order, and when an account counts as new.
 */

import { describe, expect, it } from 'vitest';

import {
  KVOX_HOME_SECTIONS,
  defaultJourneySteps,
  isJourneyStepVisible,
  isNewAccount,
  resolveJourneySteps,
} from '../../src/home/headless/index.js';
import type { KvoxJourneyStep } from '../../src/home/headless/index.js';

const holding = (...permissions: string[]) => (permission: string) => permissions.includes(permission);

const step = (key: string, extra: Partial<KvoxJourneyStep> = {}): KvoxJourneyStep => ({
  key,
  title: key,
  body: null,
  done: false,
  action: { label: key, to: `/${key}` },
  ...extra,
});

const keys = (steps: readonly KvoxJourneyStep[]) => steps.map((s) => s.key);

describe('defaultJourneySteps', () => {
  it('offers a note and the knowledge, gated on the permissions the API enforces', () => {
    const steps = defaultJourneySteps({ notes: 0 });
    expect(steps.map((s) => [s.key, s.permission, s.feature])).toEqual([
      ['write-note', 'notes:write', undefined],
      ['explore-knowledge', 'graph:read', 'graph'],
    ]);
  });

  it('marks the note step done once the person has a note', () => {
    expect(defaultJourneySteps({ notes: 0 })[0]?.done).toBe(false);
    expect(defaultJourneySteps({ notes: 3 })[0]?.done).toBe(true);
  });
});

describe('isJourneyStepVisible', () => {
  it('needs the permission', () => {
    const s = step('a', { permission: 'notes:write' });
    expect(isJourneyStepVisible(s, { hasPermission: holding(), graphEnabled: false })).toBe(false);
    expect(isJourneyStepVisible(s, { hasPermission: holding('notes:write'), graphEnabled: false })).toBe(true);
  });

  it('needs connected knowledge on for a graph step', () => {
    const s = step('a', { feature: 'graph' });
    expect(isJourneyStepVisible(s, { hasPermission: holding(), graphEnabled: false })).toBe(false);
    expect(isJourneyStepVisible(s, { hasPermission: holding(), graphEnabled: true })).toBe(true);
  });

  it('shows a step that asks for nothing to everyone', () => {
    expect(isJourneyStepVisible(step('a'), { hasPermission: holding(), graphEnabled: false })).toBe(true);
  });
});

describe('resolveJourneySteps', () => {
  const context = { hasPermission: holding('notes:write', 'graph:read'), graphEnabled: true };

  it('is the slices own steps by default', () => {
    expect(keys(resolveJourneySteps({ progress: { notes: 0 }, context }))).toEqual([
      'write-note',
      'explore-knowledge',
    ]);
  });

  it('hides the steps the viewer or the deployment rule out', () => {
    expect(
      keys(
        resolveJourneySteps({
          progress: { notes: 0 },
          context: { hasPermission: holding('graph:read'), graphEnabled: false },
        }),
      ),
    ).toEqual([]);
  });

  it('puts the host steps after the others, in the order given', () => {
    expect(
      keys(
        resolveJourneySteps({
          progress: { notes: 0 },
          context,
          extraSteps: [step('import'), step('record')],
        }),
      ),
    ).toEqual(['write-note', 'explore-knowledge', 'import', 'record']);
  });

  it('lets the host replace the slices steps, and filters its own the same way', () => {
    expect(
      keys(
        resolveJourneySteps({
          progress: { notes: 0 },
          context,
          journeySteps: [step('only')],
          extraSteps: [step('gated', { permission: 'transcripts:write' }), step('open')],
        }),
      ),
    ).toEqual(['only', 'open']);
    expect(
      keys(resolveJourneySteps({ progress: { notes: 0 }, context, journeySteps: [] })),
    ).toEqual([]);
  });
});

describe('isNewAccount', () => {
  const empty = {
    transcriptsSettled: true,
    ownedTranscripts: 0,
    recentTranscripts: 0,
    sharedTranscripts: 0,
    inProgress: 0,
    notes: 0,
  };

  it('is true when nothing exists', () => {
    expect(isNewAccount(empty)).toBe(true);
  });

  it('is false while the transcripts have not been read, or failed', () => {
    expect(isNewAccount({ ...empty, transcriptsSettled: false })).toBe(false);
  });

  it.each([
    ['an owned transcript', { ownedTranscripts: 1 }],
    ['a recent row', { recentTranscripts: 1 }],
    ['a shared transcript', { sharedTranscripts: 1 }],
    ['something in progress', { inProgress: 1 }],
    ['a note', { notes: 1 }],
  ])('is false with %s', (_label, facts) => {
    expect(isNewAccount({ ...empty, ...facts })).toBe(false);
  });
});

describe('KVOX_HOME_SECTIONS', () => {
  it('lists every section once, in page order', () => {
    expect(KVOX_HOME_SECTIONS).toEqual([
      'hero',
      'journey',
      'counts',
      'inProgress',
      'needsAttention',
      'recentTranscripts',
      'recentNotes',
      'knowledge',
      'sharedWithMe',
    ]);
  });
});
