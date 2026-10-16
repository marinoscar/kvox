import { buildEntityProfileText, buildItemProfileText, profileHash } from './profile-text';

describe('buildEntityProfileText', () => {
  it('renders every line in the documented order', () => {
    expect(
      buildEntityProfileText(
        { type: 'Person', label: 'Sarah Chen', aliases: ['Sarah Chen', 'S. Chen', 'sarah'] },
        {
          orgLabels: ['Northwind Robotics', 'northwind robotics'],
          roleTitles: ['CTO'],
          coMentioned: ['Joe', 'Pilot', 'Sarah Chen', 'Acme', 'Bob', 'Q2 plan', 'Extra'],
        },
      ),
    ).toBe(
      [
        'Person: Sarah Chen',
        'Also known as: S. Chen, sarah',
        'Organization: Northwind Robotics',
        'Role: CTO',
        'Often mentioned with: Joe, Pilot, Acme, Bob, Q2 plan',
      ].join('\n'),
    );
  });

  it('omits lines with nothing to say', () => {
    expect(buildEntityProfileText({ type: 'Organization', label: ' Acme ' })).toBe('Organization: Acme');
  });
});

describe('buildItemProfileText', () => {
  it('renders kind, title, statement and subject', () => {
    expect(
      buildItemProfileText({ kind: 'commitment', title: 'Send the deck', statement: 'Sarah will send the deck.', subjectLabel: 'Sarah Chen' }),
    ).toBe('commitment: Send the deck\nSarah will send the deck.\nAbout: Sarah Chen');
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
