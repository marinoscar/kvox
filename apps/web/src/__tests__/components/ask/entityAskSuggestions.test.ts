import { describe, expect, it } from 'vitest';

import { entityAskSuggestions } from '../../../components/ask/entityAskSuggestions';

/** The entity panel's suggested questions, per entity type (#381). */
describe('entityAskSuggestions', () => {
  it('asks a Person about commitments, role and the last discussion', () => {
    expect(entityAskSuggestions({ label: 'Joe Rivera', type: 'Person' })).toEqual([
      'What has Joe Rivera committed to?',
      "How has Joe Rivera's role changed?",
      'What did we last discuss with Joe Rivera?',
    ]);
  });

  it('asks an Organization about the latest, decisions and contacts', () => {
    expect(entityAskSuggestions({ label: 'Acme Corp', type: 'Organization' })).toEqual([
      "What's the latest on Acme Corp?",
      'Which decisions involved Acme Corp?',
      'Who do we work with at Acme Corp?',
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
    expect(entityAskSuggestions({ label: '  Joe  ', type: 'Person' })[0]).toBe('What has Joe committed to?');
  });
});
