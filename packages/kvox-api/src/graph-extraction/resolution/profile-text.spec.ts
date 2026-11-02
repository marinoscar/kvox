import { buildEntityProfileText, buildItemProfileText, profileHash } from './profile-text.js';

describe('buildEntityProfileText', () => {
  it('renders every line in the documented order', () => {
    expect(
      buildEntityProfileText(
        { type: 'Person', label: 'Sasha Example', aliases: ['Sasha Example', 'S. Example', 'sasha'] },
        {
          orgLabels: ['Org Lambda Robotics', 'org lambda robotics'],
          roleTitles: ['CTO'],
          coMentioned: ['Jonty', 'Pilot', 'Sasha Example', 'Kappa', 'Bob', 'Q2 plan', 'Extra'],
        },
      ),
    ).toBe(
      [
        'Person: Sasha Example',
        'Also known as: S. Example, sasha',
        'Organization: Org Lambda Robotics',
        'Role: CTO',
        'Often mentioned with: Jonty, Pilot, Kappa, Bob, Q2 plan',
      ].join('\n'),
    );
  });

  it('omits lines with nothing to say', () => {
    expect(buildEntityProfileText({ type: 'Organization', label: ' Kappa ' })).toBe('Organization: Kappa');
  });
});

describe('buildItemProfileText', () => {
  it('renders kind, title, statement and subject', () => {
    expect(
      buildItemProfileText({ kind: 'commitment', title: 'Send the deck', statement: 'Sasha will send the deck.', subjectLabel: 'Sasha Example' }),
    ).toBe('commitment: Send the deck\nSasha will send the deck.\nAbout: Sasha Example');
  });

  it('falls back to the statement for a missing title and drops a missing subject', () => {
    expect(buildItemProfileText({ kind: 'decision', title: null, statement: 'Ship in Q2.' })).toBe('decision: Ship in Q2.\nShip in Q2.');
  });
});

describe('profileHash', () => {
  it('keys on both the model and the text', () => {
    const a = profileHash('m1', 'x');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(profileHash('m1', 'x')).toBe(a);
    expect(profileHash('m2', 'x')).not.toBe(a);
    expect(profileHash('m1', 'y')).not.toBe(a);
  });
});
