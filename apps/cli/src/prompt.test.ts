import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { UsageError } from './errors.js';
import { canPrompt, confirm, prompt, promptSecret, select } from './prompt.js';

// =============================================================================
// A scripted terminal.
//
// readline in terminal mode reads a real TTY, so the fake has to claim to be
// one and answer setRawMode. Answers are queued up front and consumed in order,
// which is what lets a re-ask loop be tested: feed the bad answer and the good
// one, and assert the good one is what comes back.
// =============================================================================
class FakeInput extends PassThrough {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
}

class FakeOutput extends PassThrough {
  isTTY = true;
  readonly chunks: string[] = [];
  onChunk: ((text: string) => void) | undefined;

  override write(chunk: unknown, ...rest: unknown[]): boolean {
    const text = String(chunk);
    this.chunks.push(text);
    this.onChunk?.(text);
    return super.write(chunk as never, ...(rest as []));
  }

  text(): string {
    return this.chunks.join('');
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/**
 * A scripted terminal that answers only when something is actually waiting.
 *
 * Writing every answer up front does not work: readline drains the whole
 * buffer as soon as it is readable and emits a `line` event for each, and only
 * the first is claimed by the pending question - the rest are dropped, so any
 * re-ask loop hangs forever waiting for input that was already thrown away.
 *
 * A prompt is distinguishable from an informational line because readline
 * leaves the cursor on it: prompts end in a space, everything else ends in a
 * newline. So the next answer is supplied when, and only when, a prompt is
 * written.
 */
function terminal(answers: readonly string[]): {
  ctx: { input: NodeJS.ReadStream; output: NodeJS.WriteStream };
  output: FakeOutput;
} {
  const input = new FakeInput();
  const output = new FakeOutput();
  const queue = [...answers];

  output.onChunk = (text: string): void => {
    const visible = text.replace(ANSI, '');
    if (visible === '' || visible.endsWith('\n') || !visible.endsWith(' ')) return;

    const answer = queue.shift();
    if (answer === undefined) return;

    // Next tick, so readline has finished setting up the question before the
    // answer arrives.
    setImmediate(() => input.write(`${answer}\n`));
  };

  return {
    ctx: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    },
    output,
  };
}

function pipedStdin(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  const input = new PassThrough();
  const output = new FakeOutput();
  return {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  };
}

describe('canPrompt', () => {
  it('is false when stdin is not a terminal', () => {
    expect(canPrompt(pipedStdin())).toBe(false);
  });

  it('is true for a terminal', () => {
    expect(canPrompt(terminal([]).ctx)).toBe(true);
  });
});

describe('confirm', () => {
  it.each([
    ['y', true],
    ['Y', true],
    ['yes', true],
    ['YES', true],
    ['n', false],
    ['no', false],
  ])('reads %s as %s', async (answer, expected) => {
    const { ctx } = terminal([answer]);
    await expect(confirm('Proceed?', undefined, ctx)).resolves.toBe(expected);
  });

  it('returns the default on an empty line', async () => {
    const { ctx } = terminal(['']);
    await expect(confirm('Proceed?', { defaultValue: true }, ctx)).resolves.toBe(true);
  });

  it('returns a false default on an empty line', async () => {
    const { ctx } = terminal(['']);
    await expect(confirm('Delete?', { defaultValue: false }, ctx)).resolves.toBe(false);
  });

  it('re-asks on an unrecognised answer rather than assuming', async () => {
    // "yeah" is an opinion. Reading it as the default is how a confirmation
    // stops meaning anything.
    const { ctx, output } = terminal(['yeah', 'n']);

    await expect(confirm('Proceed?', { defaultValue: true }, ctx)).resolves.toBe(false);
    expect(output.text()).toContain('Please answer y or n');
  });

  it('shows which way an empty line will go', async () => {
    const { ctx, output } = terminal(['']);
    await confirm('Delete?', { defaultValue: false }, ctx);

    expect(output.text()).toContain('[y/N]');
  });

  it('fails without a terminal', async () => {
    await expect(confirm('Proceed?', undefined, pipedStdin())).rejects.toBeInstanceOf(
      UsageError,
    );
  });
});

describe('promptSecret', () => {
  it('returns the typed value', async () => {
    const { ctx } = terminal(['s3cret']);
    await expect(promptSecret('Password: ', ctx)).resolves.toBe('s3cret');
  });

  it('does not echo the value to the output', async () => {
    const { ctx, output } = terminal(['hunter2-hunter2']);

    await promptSecret('Password: ', ctx);

    // The whole point: this must not reach scrollback, a `script` log, or the
    // screen behind whoever is standing near the operator.
    expect(output.text()).not.toContain('hunter2-hunter2');
    expect(output.text()).toContain('Password:');
  });

  it('trims the answer', async () => {
    const { ctx } = terminal(['  spaced  ']);
    await expect(promptSecret('Password: ', ctx)).resolves.toBe('spaced');
  });

  it('fails without a terminal', async () => {
    await expect(promptSecret('Password: ', pipedStdin())).rejects.toBeInstanceOf(
      UsageError,
    );
  });
});

describe('select', () => {
  const choices = [
    { value: 'a' as const, label: 'Option A' },
    { value: 'b' as const, label: 'Option B' },
  ];

  it('returns the chosen value', async () => {
    const { ctx } = terminal(['2']);
    await expect(select('Pick', choices, ctx)).resolves.toBe('b');
  });

  it('lists the options with numbers', async () => {
    const { ctx, output } = terminal(['1']);
    await select('Pick', choices, ctx);

    expect(output.text()).toContain('1) Option A');
    expect(output.text()).toContain('2) Option B');
  });

  it('re-asks when the number is out of range', async () => {
    const { ctx, output } = terminal(['9', '1']);

    await expect(select('Pick', choices, ctx)).resolves.toBe('a');
    expect(output.text()).toContain('between 1 and 2');
  });

  it('re-asks when the answer is not a number', async () => {
    const { ctx } = terminal(['abc', '2']);
    await expect(select('Pick', choices, ctx)).resolves.toBe('b');
  });

  it('rejects an empty choice list', async () => {
    const { ctx } = terminal([]);
    await expect(select('Pick', [], ctx)).rejects.toBeInstanceOf(UsageError);
  });
});

describe('prompt', () => {
  it('writes the question to the output and trims the answer', async () => {
    const { ctx, output } = terminal(['  value  ']);

    await expect(prompt('Question: ', ctx)).resolves.toBe('value');
    expect(output.text()).toContain('Question:');
  });
});
