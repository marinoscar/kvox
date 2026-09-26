import { AnswerHold } from './answer-hold';

describe('AnswerHold (#378)', () => {
  it('holds text until the threshold, then releases it and passes later deltas straight through', () => {
    const hold = new AnswerHold(10);
    expect(hold.delta('Hello ')).toBe('');
    expect(hold.released).toBe(false);
    expect(hold.delta('world!')).toBe('Hello world!');
    expect(hold.released).toBe(true);
    expect(hold.delta(' More.')).toBe(' More.');
    expect(hold.end()).toBe('');
    expect(hold.text).toBe('Hello world! More.');
  });

  it('discards a preamble when a tool call arrives before the threshold — it never reaches the answer', () => {
    const hold = new AnswerHold(64);
    expect(hold.delta('Let me look that up.')).toBe('');
    expect(hold.toolCall()).toBe('Let me look that up.');
    // Anything after the tool call in the same call stays out too.
    expect(hold.delta(' '.repeat(100))).toBe('');
    expect(hold.end()).toBe('');
    expect(hold.lateToolCall).toBe(false);
    expect(hold.text).toBe(`Let me look that up.${' '.repeat(100)}`);
  });

  it('releases a short answer at the end of a call that made no tool call', () => {
    const hold = new AnswerHold(64);
    expect(hold.delta('Yes.')).toBe('');
    expect(hold.end()).toBe('Yes.');
    expect(hold.released).toBe(true);
  });

  it('flags a tool call that arrives after the answer started, without un-writing anything', () => {
    const hold = new AnswerHold(4);
    expect(hold.delta('Acme is a client.')).toBe('Acme is a client.');
    expect(hold.toolCall()).toBe('');
    expect(hold.lateToolCall).toBe(true);
    expect(hold.end()).toBe('');
  });

  it('ignores empty deltas', () => {
    const hold = new AnswerHold(1);
    expect(hold.delta('')).toBe('');
    expect(hold.released).toBe(false);
    expect(hold.end()).toBe('');
  });

  it('concatenating every returned piece reproduces the released text exactly', () => {
    const hold = new AnswerHold(64);
    const parts = ['The ', 'answer ', 'is ', 'long '.repeat(20), 'and ends here.'];
    let out = '';
    for (const p of parts) out += hold.delta(p);
    out += hold.end();
    expect(out).toBe(parts.join(''));
  });
});
