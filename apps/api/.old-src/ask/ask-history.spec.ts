import { fitToBudget, messageTokens, MESSAGE_OVERHEAD_TOKENS, selectHistory, type AskHistoryRow } from './ask-history';

const u = (content: string, status: AskHistoryRow['status'] = 'complete'): AskHistoryRow => ({ role: 'user', status, content });
const a = (content: string, status: AskHistoryRow['status'] = 'complete'): AskHistoryRow => ({
  role: 'assistant',
  status,
  content,
});

/** One token per character — easy arithmetic. */
const chars = (text: string) => text.length;

describe('selectHistory (#378)', () => {
  it('replays complete turns oldest first with citation markers stripped', () => {
    const history = selectHistory([u('Who is Sarah?'), a('Sarah[^ent1] leads Atlas.[^ev2]')], 10);
    expect(history).toEqual([
      { role: 'user', content: 'Who is Sarah?' },
      { role: 'assistant', content: 'Sarah leads Atlas.' },
    ]);
  });

  it('skips a failed turn whole — the question with its failed answer', () => {
    const history = selectHistory([u('Q1'), a('A1'), u('Q2'), a('partial', 'failed'), u('Q3'), a('A3')], 10);
    expect(history.map((m) => m.content)).toEqual(['Q1', 'A1', 'Q3', 'A3']);
  });

  it('skips unfinished and empty messages', () => {
    const history = selectHistory([u('Q1'), a('', 'complete'), u('Q2'), a('x', 'streaming')], 10);
    expect(history.map((m) => m.content)).toEqual(['Q1']);
  });

  it('keeps at most `limit` messages, the newest', () => {
    const rows = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? u(`Q${i}`) : a(`A${i}`)));
    const history = selectHistory(rows, 4);
    expect(history.map((m) => m.content)).toEqual(['Q8', 'A9', 'Q10', 'A11']);
    expect(selectHistory(rows, 0)).toEqual([]);
  });
});

describe('messageTokens', () => {
  it('counts content, tool calls and a per-message overhead', () => {
    const n = messageTokens(
      [
        { role: 'user', content: 'abcd' },
        { role: 'assistant', content: null, toolCalls: [{ id: '1', name: 'search', argumentsJson: '{}' }] },
        { role: 'tool', toolCallId: '1', content: 'xy' },
      ],
      chars,
    );
    expect(n).toBe(MESSAGE_OVERHEAD_TOKENS * 4 + 4 + 'search{}'.length + 2);
  });
});

describe('fitToBudget', () => {
  const history = [
    { role: 'user' as const, content: 'q'.repeat(100) },
    { role: 'assistant' as const, content: 'a'.repeat(100) },
    { role: 'user' as const, content: 'r'.repeat(100) },
    { role: 'assistant' as const, content: 'b'.repeat(100) },
  ];

  it('keeps everything when it fits', () => {
    const fit = fitToBudget({ system: 'sys', history, question: 'Q?', availableTokens: 10_000, reservedTokens: 0, countTokens: chars });
    expect(fit.ok && fit.messages.length).toBe(6);
    expect(fit.ok && fit.droppedHistory).toBe(0);
  });

  it('drops the oldest history first and never starts on an orphaned answer', () => {
    // base (sys + Q) = 3 + 2 + 2 overheads = 13; each history message = 104. Room for two.
    const fit = fitToBudget({ system: 'sys', history, question: 'Q?', availableTokens: 13 + 3 * 104, reservedTokens: 0, countTokens: chars });
    if (!fit.ok) throw new Error('expected a fit');
    // Dropping one leaves [a, r, b], which starts with an answer — that goes too.
    expect(fit.messages.map((m) => m.content?.[0])).toEqual(['s', 'r', 'b', 'Q']);
    expect(fit.droppedHistory).toBe(2);
    expect(fit.messages[0].role).toBe('system');
    expect(fit.messages[fit.messages.length - 1]).toEqual({ role: 'user', content: 'Q?' });
  });

  it('refuses (never truncates) when the system prompt and the question alone do not fit', () => {
    const fit = fitToBudget({
      system: 'sys',
      history,
      question: 'x'.repeat(500),
      availableTokens: 400,
      reservedTokens: 50,
      countTokens: chars,
    });
    expect(fit).toEqual({ ok: false, requiredTokens: 3 + 500 + 2 * MESSAGE_OVERHEAD_TOKENS + 50 });
  });
});
