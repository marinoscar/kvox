import { mentionsSelf, selfNames } from './graph-self.js';

const SELF = { label: 'Avery Example', aliases: ['Avery', 'A. Example'] };

describe('selfNames / mentionsSelf (#778)', () => {
  it('normalizes the label and every alias', () => {
    expect([...selfNames(SELF)].sort()).toEqual(['a. example', 'avery', 'avery example']);
  });

  it('matches a mention by label or by any alias, ignoring case and punctuation', () => {
    expect(mentionsSelf(SELF, { label: 'AVERY EXAMPLE', aliases: [] })).toBe(true);
    expect(mentionsSelf(SELF, { label: 'Someone', aliases: ['avery'] })).toBe(true);
    expect(mentionsSelf(SELF, { label: 'A. EXAMPLE', aliases: [] })).toBe(true);
  });

  it('does not match a different name or a name with no letters', () => {
    expect(mentionsSelf(SELF, { label: 'Averil Example', aliases: [] })).toBe(false);
    expect(mentionsSelf(SELF, { label: '---', aliases: [] })).toBe(false);
  });
});
