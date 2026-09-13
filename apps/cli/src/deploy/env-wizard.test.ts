import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import { parseEnvExample } from './env-spec.js';
import { runEnvWizard } from './env-wizard.js';

// Same scripted terminal as prompt.test.ts: an answer is supplied only when
// something is actually waiting for one, because readline drops buffered lines
// that no question has claimed.
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

function terminal(answers: readonly string[]): {
  ctx: { input: NodeJS.ReadStream; output: NodeJS.WriteStream };
  output: FakeOutput;
  remaining: () => number;
} {
  const input = new FakeInput();
  const output = new FakeOutput();
  const queue = [...answers];

  output.onChunk = (text: string): void => {
    const visible = text.replace(ANSI, '');
    if (visible === '' || visible.endsWith('\n') || !visible.endsWith(' ')) return;
    const answer = queue.shift();
    if (answer === undefined) return;
    setImmediate(() => input.write(`${answer}\n`));
  };

  return {
    ctx: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    },
    output,
    remaining: () => queue.length,
  };
}

/** A template small enough that the answer sequence stays readable. */
const TEMPLATE = [
  '# ------------------------------------------------------------',
  '# Application',
  '# ------------------------------------------------------------',
  'NODE_ENV=development',
  'APP_URL=http://localhost:3535',
  'PORT=3000',
  '',
  '# ------------------------------------------------------------',
  '# Database',
  '# ------------------------------------------------------------',
  '# The database host.',
  'POSTGRES_HOST=localhost',
  'POSTGRES_USER=postgres',
  'POSTGRES_PASSWORD=postgres',
  'POSTGRES_DB=appdb',
  '',
  '# ------------------------------------------------------------',
  '# JWT / Session',
  '# ------------------------------------------------------------',
  'JWT_SECRET=your-super-secret-key-min-32-characters-long',
  '',
  '# ------------------------------------------------------------',
  '# Test Authentication',
  '# ------------------------------------------------------------',
  'TEST_AUTH_ENABLED=false',
  '',
  '# ------------------------------------------------------------',
  '# Storage',
  '# ------------------------------------------------------------',
  'S3_BUCKET=your-bucket-name',
].join('\n');

const SPECS = parseEnvExample(TEMPLATE);

/** Answers for the default (essential-only) run, in prompt order. */
const ESSENTIAL_ANSWERS = [
  'db.example.test', // POSTGRES_HOST
  'appuser', // POSTGRES_USER
  'sup3rs3cret-password', // POSTGRES_PASSWORD (secret)
  'appdb', // POSTGRES_DB
  'y', // JWT_SECRET: generate one?
  'y', // review: write this environment?
];

describe('runEnvWizard', () => {
  it('asks only the essential keys and defaults the rest', async () => {
    const { ctx, output, remaining } = terminal(ESSENTIAL_ANSWERS);

    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    // Every scripted answer was consumed, so no extra questions were asked.
    expect(remaining()).toBe(0);
    expect(values.get('POSTGRES_HOST')).toBe('db.example.test');
    // PORT was never asked; it took the template default.
    expect(values.get('PORT')).toBe('3000');
    expect(output.text()).not.toContain('PORT [');
  });

  it('forces NODE_ENV to production', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    expect(values.get('NODE_ENV')).toBe('production');
  });

  it('never writes TEST_AUTH_ENABLED', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    // True in production fails startup by design, so it is not carried at all.
    expect(values.has('TEST_AUTH_ENABLED')).toBe(false);
  });

  it('derives APP_URL from the domain instead of asking', async () => {
    const { ctx, output } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    expect(values.get('APP_URL')).toBe('https://app.example.test');
    expect(output.text()).not.toContain('APP_URL [');
  });

  it('generates a secret when offered and accepted', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    const generated = values.get('JWT_SECRET') as string;
    expect(generated).not.toBe('your-super-secret-key-min-32-characters-long');
    expect(generated.length).toBeGreaterThanOrEqual(32);
  });

  it('re-asks on the same key when a value fails validation', async () => {
    const { ctx, output } = terminal([
      'db.example.test',
      'appuser',
      'pw-that-is-fine',
      'appdb',
      'n', // decline generation for JWT_SECRET
      'too-short', // rejected: under 32 characters
      'a-perfectly-long-replacement-secret-value',
      'y',
    ]);

    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    expect(output.text()).toContain('JWT_SECRET must be at least 32');
    expect(values.get('JWT_SECRET')).toBe('a-perfectly-long-replacement-secret-value');
  });

  it('skips a group the operator did not opt into', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    expect(values.has('S3_BUCKET')).toBe(false);
  });

  it('includes a group when asked for it', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      groups: ['storage'],
      ctx,
    });

    // Not essential, so it takes the template default rather than prompting.
    expect(values.get('S3_BUCKET')).toBe('your-bucket-name');
  });

  it('uses existing values as defaults and does not re-ask for a secret', async () => {
    const existing = new Map([
      ['POSTGRES_PASSWORD', 'already-set-password'],
      ['JWT_SECRET', 'an-existing-secret-of-sufficient-length'],
    ]);

    const { ctx, remaining } = terminal([
      'db.example.test', // POSTGRES_HOST
      'appuser', // POSTGRES_USER
      '', // POSTGRES_PASSWORD: essential, blank keeps the existing value
      'appdb', // POSTGRES_DB
      '', // JWT_SECRET: essential too, so still asked; blank keeps it
      'y', // review
    ]);

    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      existing,
      ctx,
    });

    // A blank answer keeps what is already there, so a re-run does not force
    // anyone to retype a working password.
    expect(values.get('POSTGRES_PASSWORD')).toBe('already-set-password');
    expect(values.get('JWT_SECRET')).toBe('an-existing-secret-of-sufficient-length');
    // No generation offer: it is only made when there is nothing usable yet.
    expect(remaining()).toBe(0);
  });

  it('carries through a key the template does not know about', async () => {
    const { ctx } = terminal(ESSENTIAL_ANSWERS);

    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      existing: new Map([['SENTRY_DSN', 'https://example']]),
      ctx,
    });

    // Silently dropping a value someone deliberately set is the worst thing
    // this could do.
    expect(values.get('SENTRY_DSN')).toBe('https://example');
  });

  it('asks about everything under --all', async () => {
    const { ctx, remaining } = terminal([
      '', // APP_URL is derived, so the first question is PORT
      'db.example.test',
      'appuser',
      'pw-that-is-fine',
      'appdb',
      'n', // decline generation
      'a-perfectly-long-replacement-secret-value',
      'bucket-name',
      'y', // review
    ]);

    await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      all: true,
      groups: ['storage'],
      ctx,
    });

    expect(remaining()).toBe(0);
  });

  it('never shows a secret in the review summary', async () => {
    const { ctx, output } = terminal(ESSENTIAL_ANSWERS);

    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      ctx,
    });

    const password = values.get('POSTGRES_PASSWORD') as string;
    const jwt = values.get('JWT_SECRET') as string;

    expect(password).toBe('sup3rs3cret-password');
    expect(output.text()).not.toContain(password);
    expect(output.text()).not.toContain(jwt);
    expect(output.text()).toContain('********');
  });

  it('aborts when the review is declined', async () => {
    const { ctx } = terminal([...ESSENTIAL_ANSWERS.slice(0, -1), 'n']);

    await expect(
      runEnvWizard({ specs: SPECS, domain: 'app.example.test', ctx }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('runEnvWizard --non-interactive', () => {
  it('lists every unresolved key at once, not just the first', async () => {
    const error = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: new Map([['POSTGRES_HOST', 'db.example.test']]),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    const message = (error as Error).message;

    // A CI operator learning about these one run at a time is a bad afternoon.
    expect(message).toContain('POSTGRES_USER');
    expect(message).toContain('POSTGRES_DB');
    expect(message).toContain('JWT_SECRET');
    expect(message).not.toContain('POSTGRES_HOST');
  });

  it('rejects a value that is present but still the placeholder', async () => {
    const error = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: new Map([
        ['POSTGRES_HOST', 'db.example.test'],
        ['POSTGRES_USER', 'appuser'],
        ['POSTGRES_PASSWORD', 'pw-that-is-fine'],
        ['POSTGRES_DB', 'appdb'],
        // Straight from .env.example, which is not a configured value.
        ['JWT_SECRET', 'your-super-secret-key-min-32-characters-long'],
      ]),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('JWT_SECRET');
  });

  it('succeeds and prompts for nothing when the environment is complete', async () => {
    const { values } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: new Map([
        ['POSTGRES_HOST', 'db.example.test'],
        ['POSTGRES_USER', 'appuser'],
        ['POSTGRES_PASSWORD', 'pw-that-is-fine'],
        ['POSTGRES_DB', 'appdb'],
        ['JWT_SECRET', 'a-perfectly-long-replacement-secret-value'],
      ]),
    });

    expect(values.get('NODE_ENV')).toBe('production');
    expect(values.get('APP_URL')).toBe('https://app.example.test');
    expect(values.get('POSTGRES_USER')).toBe('appuser');
  });
});
