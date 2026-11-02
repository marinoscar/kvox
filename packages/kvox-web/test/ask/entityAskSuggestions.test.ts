import { describe, expect, it } from 'vitest';

import { entityAskSuggestions } from '../../src/ask/headless/index.js';

/** The entity panel's suggested questions, per entity type (#381). */
describe('entityAskSuggestions', () => {
  it('asks a Person about commitments, role and the last discussion', () => {
    expect(entityAskSuggestions({ label: 'Jonty Placeholder', type: 'Person' })).toEqual([
      'What has Jonty Placeholder committed to?',
      "How has Jonty Placeholder's role changed?",
      'What did we last discuss with Jonty Placeholder?',
    ]);
  });

  it('asks an Organization about the latest, decisions and contacts', () => {
    expect(entityAskSuggestions({ label: 'Org Kappa', type: 'Organization' })).toEqual([
      "What's the latest on Org Kappa?",
      'Which decisions involved Org Kappa?',
      'Who do we work with at Org Kappa?',
    ]);
  });

  it('asks a Project about status, open work and decisions', () => {
    expect(entityAskSuggestions({ label: 'Project Atlas', type: 'Project' })).toEqual([
      "What's the status of Project Atlas?",
      "What's still open on Project Atlas?",
      'Which decisions changed Project Atlas?',
    ]);
  });

  it.each(['Meeting', 'u_custom_type', 'toString', 'person'])('offers one generic question for %s', (type) => {
    expect(entityAskSuggestions({ label: 'Weekly sync', type })).toEqual(["What's the latest on Weekly sync?"]);
  });

  it('trims the label', () => {
    expect(entityAskSuggestions({ label: '  Jonty  ', type: 'Person' })[0]).toBe('What has Jonty committed to?');
  });
});
