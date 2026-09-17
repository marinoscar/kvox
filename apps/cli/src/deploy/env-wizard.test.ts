import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import type { Check, CheckResult } from './checks/index.js';
import {
  CommandFailedError,
  type CommandResult,
  type RunCommandOptions,
} from './executor.js';
import { parseEnvExample } from './env-spec.js';
import { runEnvWizard, type WizardCheckOptions } from './env-wizard.js';
import { unknownServerFacts, type ServerFacts } from './server-facts.js';
import {
  INSTALL_WIZARD_STEPS,
  runStepChecks,
  type StepCheckBase,
  type StepCheckContext,
  type WizardStep,
} from './wizard/steps.js';

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

  it('asks about everything under --all, in step order', async () => {
    const { ctx, remaining } = terminal([
      // APP_URL is derived; the database step opens the questions.
      'db.example.test',
      'appuser',
      'pw-that-is-fine',
      'appdb',
      'n', // decline generation
      'a-perfectly-long-replacement-secret-value',
      'bucket-name', // the storage step
      '', // PORT, in the catch-all step at the end
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
  it('lists every truly unanswerable key at once, and generates the secrets', async () => {
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
    expect(message).not.toContain('POSTGRES_HOST');
    // JWT_SECRET has `generate` metadata: without a terminal there is nobody
    // to ask, so it is generated rather than reported (#127).
    expect(message).not.toContain('JWT_SECRET');
  });

  it('still reports a blank secret when generateMissing is off', async () => {
    const error = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      generateMissing: false,
      existing: new Map([['POSTGRES_HOST', 'db.example.test']]),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('JWT_SECRET');
  });

  it('succeeds with only the database supplied, generating every secret', async () => {
    const { values, summary } = await runEnvWizard({
      specs: SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: new Map([
        ['POSTGRES_HOST', 'db.example.test'],
        ['POSTGRES_USER', 'appuser'],
        ['POSTGRES_PASSWORD', 'pw-that-is-fine'],
        ['POSTGRES_DB', 'appdb'],
      ]),
    });

    const jwt = values.get('JWT_SECRET') as string;
    expect(jwt.length).toBeGreaterThanOrEqual(32);
    expect(jwt).not.toContain('your-');
    expect(summary.find((row) => row.key === 'JWT_SECRET')?.source).toBe('generated');
  });

  it('reports the domain as unresolved when none was given', async () => {
    const error = await runEnvWizard({
      specs: SPECS,
      nonInteractive: true,
      existing: new Map([
        ['POSTGRES_HOST', 'db.example.test'],
        ['POSTGRES_USER', 'appuser'],
        ['POSTGRES_PASSWORD', 'pw-that-is-fine'],
        ['POSTGRES_DB', 'appdb'],
      ]),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('--domain');
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

// =============================================================================
// Wizard v2  (issue #127, epic #118)
// =============================================================================

/** A template with the v2 keys: SSL, the resource keys, an optional key. */
const V2_TEMPLATE = [
  '# ------------------------------------------------------------',
  '# Application',
  '# ------------------------------------------------------------',
  'NODE_ENV=development',
  'APP_URL=http://localhost:3535',
  'APP_BIND_PORT=3535',
  'API_MEM_LIMIT=512M',
  '',
  '# ------------------------------------------------------------',
  '# Database',
  '# ------------------------------------------------------------',
  'POSTGRES_HOST=localhost',
  'POSTGRES_USER=postgres',
  'POSTGRES_PASSWORD=postgres',
  'POSTGRES_DB=appdb',
  'POSTGRES_SSL=false',
  '',
  '# ------------------------------------------------------------',
  '# JWT / Session',
  '# ------------------------------------------------------------',
  'JWT_SECRET=your-super-secret-key-min-32-characters-long',
  'JOBS_WORKER_CONCURRENCY=2',
  '# An optional one.',
  '# OTEL_DEBUG=true',
].join('\n');

const V2_SPECS = parseEnvExample(V2_TEMPLATE);

const V2_DATABASE = new Map([
  ['POSTGRES_HOST', 'db.example.test'],
  ['POSTGRES_USER', 'appuser'],
  ['POSTGRES_PASSWORD', 'pw-that-is-fine'],
  ['POSTGRES_DB', 'appdb'],
]);

const GIB = 1024 * 1024 * 1024;

function facts(overrides: Partial<ServerFacts> = {}): ServerFacts {
  return { ...unknownServerFacts(), cpus: 4, memoryBytes: 8 * GIB, ...overrides };
}

/** A registry check whose outcome the test scripts, call by call. */
function scriptedCheck(id: string, outcomes: readonly CheckResult[]): { check: Check; calls: () => number } {
  let calls = 0;
  return {
    check: {
      id,
      title: id,
      severity: 'required',
      async run() {
        const outcome = outcomes[Math.min(calls, outcomes.length - 1)] as CheckResult;
        calls += 1;
        return outcome;
      },
    },
    calls: () => calls,
  };
}

/** The install steps trimmed to one step running one named check. */
function stepsChecking(stepId: string, ids: readonly string[]): WizardStep[] {
  return INSTALL_WIZARD_STEPS.map((step) =>
    step.id === stepId
      ? { ...step, checkIds: ids, onLeave: (context) => runStepChecks(ids, context) }
      : { ...step, checkIds: [], onLeave: undefined },
  );
}

function inlineChecks(checks: readonly Check[]): WizardCheckOptions {
  return {
    checks,
    context: {
      runCommand: (async () => {
        throw new Error('no command should run in this test');
      }) as unknown as StepCheckBase['runCommand'],
      deployRoot: '/tmp/app',
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
    },
  };
}

describe('runEnvWizard v2: POSTGRES_SSL', () => {
  it('asks for POSTGRES_SSL in the database step, defaulting to false', async () => {
    const { ctx, output, remaining } = terminal([
      'db.example.test',
      'appuser',
      'pw-that-is-fine',
      'appdb',
      '', // POSTGRES_SSL: Enter keeps false
      'y', // JWT_SECRET: generate
      '', '', '', // the three resource suggestions
      'y', // review
    ]);

    const { values } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      facts: facts(),
      portFree: async () => true,
      ctx,
    });

    expect(remaining()).toBe(0);
    expect(output.text()).toContain('POSTGRES_SSL [false]');
    expect(values.get('POSTGRES_SSL')).toBe('false');
  });

  it('rejects anything but true or false, on the field', async () => {
    const { ctx, output } = terminal([
      'db.example.test',
      'appuser',
      'pw-that-is-fine',
      'appdb',
      'yes', // rejected
      'true',
      'y', // JWT_SECRET
      '', '', '', // the three resource suggestions
      'y', // review
    ]);

    const { values } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      facts: facts(),
      portFree: async () => true,
      ctx,
    });

    expect(output.text()).toContain('POSTGRES_SSL must be true or false');
    expect(values.get('POSTGRES_SSL')).toBe('true');
  });

  it('accepts the template default unattended, since false is a real answer', async () => {
    const { values } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: V2_DATABASE,
      facts: facts(),
      portFree: async () => true,
    });

    expect(values.get('POSTGRES_SSL')).toBe('false');
  });
});

describe('runEnvWizard v2: server-derived suggestions', () => {
  it('shows each suggestion with its reason and takes it on Enter', async () => {
    const { ctx, output, remaining } = terminal([
      'db.example.test',
      'appuser',
      'pw-that-is-fine',
      'appdb',
      '', // POSTGRES_SSL
      'y', // JWT_SECRET
      '', // APP_BIND_PORT: accept the suggestion
      '', // JOBS_WORKER_CONCURRENCY
      '', // API_MEM_LIMIT
      'y', // review
    ]);

    const { values, summary } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      facts: facts({ cpus: 4, memoryBytes: 8 * GIB }),
      siblingPorts: [{ name: 'demo', port: 3535 }],
      portFree: async () => true,
      ctx,
    });

    expect(remaining()).toBe(0);
    expect(output.text()).toContain('Suggested: 3536 (3535 is used by demo)');
    expect(output.text()).toContain('Suggested: 3 (4 CPUs detected)');
    expect(output.text()).toContain('Suggested: 2g (8 GiB RAM detected)');
    expect(values.get('APP_BIND_PORT')).toBe('3536');
    expect(values.get('JOBS_WORKER_CONCURRENCY')).toBe('3');
    expect(values.get('API_MEM_LIMIT')).toBe('2g');

    const port = summary.find((row) => row.key === 'APP_BIND_PORT');
    expect(port?.source).toBe('suggested');
    expect(port?.reason).toBe('3535 is used by demo');
    // The review table carries the reason too.
    expect(output.text()).toContain('3536  (suggested: 3535 is used by demo)');
  });

  it('lets the operator overrule a suggestion', async () => {
    const { ctx } = terminal([
      'db.example.test',
      'appuser',
      'pw-that-is-fine',
      'appdb',
      '',
      'y',
      '4000', // APP_BIND_PORT: typed instead
      '',
      '',
      'y',
    ]);

    const { values, summary } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      facts: facts(),
      portFree: async () => true,
      ctx,
    });

    expect(values.get('APP_BIND_PORT')).toBe('4000');
    expect(summary.find((row) => row.key === 'APP_BIND_PORT')?.source).toBe('asked');
  });

  it('never second-guesses a value already set', async () => {
    const { values, summary } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: new Map([...V2_DATABASE, ['APP_BIND_PORT', '4000']]),
      facts: facts(),
      siblingPorts: [{ name: 'demo', port: 4000 }],
      portFree: async () => true,
    });

    expect(values.get('APP_BIND_PORT')).toBe('4000');
    expect(summary.find((row) => row.key === 'APP_BIND_PORT')?.source).toBe('existing');
  });

  it('applies suggestions unattended, printing every reason in the review table', async () => {
    const output = new FakeOutput();
    const { values, summary } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: V2_DATABASE,
      facts: facts({ cpus: 2, memoryBytes: 2 * GIB }),
      siblingPorts: [{ name: 'demo', port: 3535 }],
      portFree: async () => true,
      ctx: { output: output as unknown as NodeJS.WriteStream },
    });

    expect(values.get('APP_BIND_PORT')).toBe('3536');
    expect(values.get('JOBS_WORKER_CONCURRENCY')).toBe('1');
    expect(values.get('API_MEM_LIMIT')).toBe('512m');
    for (const row of summary.filter((entry) => entry.source === 'suggested')) {
      expect(row.reason).toBeTruthy();
      expect(output.text()).toContain(`${row.display}  (suggested: ${row.reason})`);
    }
  });

  it('falls back to the template default when the server is unknown', async () => {
    const { values, summary } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: V2_DATABASE,
      portFree: async () => true,
    });

    // No CPU count: no opinion, and the template's 2 stands.
    expect(values.get('JOBS_WORKER_CONCURRENCY')).toBe('2');
    expect(summary.find((row) => row.key === 'JOBS_WORKER_CONCURRENCY')?.source).toBe('default');
  });
});

describe('runEnvWizard v2: inline checks', () => {
  it('re-enters the database step with the remedy shown when a check fails, before any later question', async () => {
    const credentials = scriptedCheck('database-credentials', [
      { status: 'fail', detail: 'password authentication failed for appuser', remedy: 'Check POSTGRES_USER and POSTGRES_PASSWORD.' },
      { status: 'pass', detail: 'appuser authenticated' },
    ]);
    const { ctx, output, remaining } = terminal([
      'db.example.test',
      'appuser',
      'wrong-password',
      'appdb',
      '', // SSL
      'y', // correct them now?
      '', // host: kept
      '', // user: kept
      'right-password', // the one that was wrong
      '', // db: kept
      '', // SSL: kept
      'y', // JWT_SECRET
      '', // APP_BIND_PORT
      '', // JOBS_WORKER_CONCURRENCY
      '', // API_MEM_LIMIT
      'y', // review
    ]);

    const { values, checks } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      facts: facts(),
      portFree: async () => true,
      steps: stepsChecking('database', ['database-credentials']),
      inlineChecks: inlineChecks([credentials.check]),
      ctx,
    });

    expect(remaining()).toBe(0);
    const text = output.text();
    expect(text).toContain('Check POSTGRES_USER and POSTGRES_PASSWORD.');
    // The failure was shown BEFORE the secrets step was ever reached.
    expect(text.indexOf('password authentication failed')).toBeLessThan(text.indexOf('JWT_SECRET is unset'));
    expect(credentials.calls()).toBe(2);
    expect(values.get('POSTGRES_PASSWORD')).toBe('right-password');
    expect(checks.map((check) => check.status)).toEqual(['fail', 'pass']);
  });

  it('runs the checks against the typed values, not the template', async () => {
    let seen: ReadonlyMap<string, string> | undefined;
    let seenDomain: string | undefined;
    const probe: Check = {
      id: 'database-reachable',
      title: 'reachable',
      severity: 'required',
      async run(context) {
        seen = context.env;
        seenDomain = context.domain;
        return { status: 'pass', detail: 'ok' };
      },
    };

    await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: V2_DATABASE,
      facts: facts(),
      portFree: async () => true,
      steps: stepsChecking('database', ['database-reachable']),
      inlineChecks: inlineChecks([probe]),
    });

    expect(seen?.get('POSTGRES_HOST')).toBe('db.example.test');
    expect(seen?.get('POSTGRES_PASSWORD')).toBe('pw-that-is-fine');
    expect(seenDomain).toBe('app.example.test');
  });

  it('shows a warning and moves on', async () => {
    const privileges = scriptedCheck('database-privileges', [
      { status: 'warn', detail: 'appuser cannot create in schema public', remedy: 'GRANT CREATE ON SCHEMA public TO appuser;' },
    ]);
    const { ctx, output, remaining } = terminal([
      'db.example.test', 'appuser', 'pw-that-is-fine', 'appdb', '',
      'y', '', '', '', 'y',
    ]);

    await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      facts: facts(),
      portFree: async () => true,
      steps: stepsChecking('database', ['database-privileges']),
      inlineChecks: inlineChecks([privileges.check]),
      ctx,
    });

    expect(remaining()).toBe(0);
    expect(output.text()).toContain('GRANT CREATE ON SCHEMA public TO appuser;');
    expect(privileges.calls()).toBe(1);
  });

  it('turns a failure into one UsageError naming every failing check when unattended', async () => {
    const dns = scriptedCheck('dns-points-here', [
      { status: 'fail', detail: 'app.example.test resolves to 203.0.113.9, but this server is 198.51.100.7', remedy: 'Point the record here.' },
    ]);
    const credentials = scriptedCheck('database-credentials', [
      { status: 'fail', detail: 'password authentication failed for appuser', remedy: 'Check POSTGRES_PASSWORD.' },
    ]);
    const steps = INSTALL_WIZARD_STEPS.map((step) =>
      step.id === 'domain'
        ? { ...step, onLeave: (context: StepCheckContext) => runStepChecks(['dns-points-here'], context) }
        : step.id === 'database'
          ? { ...step, onLeave: (context: StepCheckContext) => runStepChecks(['database-credentials'], context) }
          : { ...step, onLeave: undefined },
    );

    const error = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: V2_DATABASE,
      facts: facts(),
      portFree: async () => true,
      steps,
      inlineChecks: inlineChecks([dns.check, credentials.check]),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    const message = (error as Error).message;
    // Both, in one error: the DNS failure did not hide the database one.
    expect(message).toContain('203.0.113.9');
    expect(message).toContain('198.51.100.7');
    expect(message).toContain('password authentication failed');
    expect(message).toContain('Point the record here.');
  });

  it('runs no check at all when inlineChecks is not given', async () => {
    const credentials = scriptedCheck('database-credentials', [{ status: 'fail', detail: 'x', remedy: 'y' }]);

    await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: V2_DATABASE,
      portFree: async () => true,
      steps: stepsChecking('database', ['database-credentials']),
    });

    expect(credentials.calls()).toBe(0);
  });

  it('lets the operator stop rather than loop forever on a check that keeps failing', async () => {
    const credentials = scriptedCheck('database-credentials', [{ status: 'fail', detail: 'nope', remedy: 'fix it' }]);
    const { ctx } = terminal(['db.example.test', 'appuser', 'pw', 'appdb', '', 'n']);

    const error = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      facts: facts(),
      portFree: async () => true,
      steps: stepsChecking('database', ['database-credentials']),
      inlineChecks: inlineChecks([credentials.check]),
      ctx,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('fix it');
  });
});

describe('runEnvWizard v2: the domain step', () => {
  it('asks for the domain when none was given and derives from the answer', async () => {
    const { ctx, output } = terminal([
      'not a host', // rejected
      'app.example.test',
      ...ESSENTIAL_ANSWERS,
    ]);

    const { values, domain } = await runEnvWizard({ specs: SPECS, ctx });

    expect(output.text()).toContain('! Domain must be a hostname');
    expect(domain).toBe('app.example.test');
    expect(values.get('APP_URL')).toBe('https://app.example.test');
  });

  it('prints the OAuth redirect URI before asking for the client id', async () => {
    const template = [
      'GOOGLE_CLIENT_ID=your-google-client-id',
      'GOOGLE_CLIENT_SECRET=your-google-client-secret',
    ].join('\n');
    const { ctx, output } = terminal(['client-id', 'client-secret', 'y']);

    await runEnvWizard({ specs: parseEnvExample(template), domain: 'app.example.test', ctx });

    const text = output.text();
    expect(text).toContain('https://app.example.test/api/auth/google/callback');
    expect(text.indexOf('/api/auth/google/callback')).toBeLessThan(text.indexOf('GOOGLE_CLIENT_ID ['));
  });
});

// =============================================================================
// offerDatabaseCreation  (issue #238)
// =============================================================================
//
// Drives the offer entirely through runEnvWizard, wiring the `database-exists`
// check as a scripted check (like the inline-check tests above) and a fake
// `runCommand` that only the CREATE DATABASE action itself calls - the check
// never calls runCommand at all, so any invocation this fake sees is proof
// the action ran.
// =============================================================================

type PsqlCanned = { exitCode: number; stdout?: string; stderr?: string };
type PsqlResponder = (argv: readonly string[], options: RunCommandOptions) => PsqlCanned | undefined;

function fakePsqlRunner(respond: PsqlResponder): {
  runCommand: StepCheckBase['runCommand'];
  calls: () => number;
} {
  let calls = 0;
  const runCommand = (async (
    argv: readonly string[],
    options: RunCommandOptions,
  ): Promise<CommandResult> => {
    calls += 1;
    const canned = respond(argv, options) ?? { exitCode: 0, stdout: '' };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) throw new CommandFailedError(result.stderr || 'failed', result);
    return result;
  }) as StepCheckBase['runCommand'];
  return { runCommand, calls: () => calls };
}

/** Succeeds on the CREATE DATABASE statement; passes anything else through. */
function successfulCreate(): { runCommand: StepCheckBase['runCommand']; calls: () => number } {
  return fakePsqlRunner(() => ({ exitCode: 0, stdout: '' }));
}

/** Fails the CREATE DATABASE statement with a permission error. */
function refusedCreate(): { runCommand: StepCheckBase['runCommand']; calls: () => number } {
  return fakePsqlRunner((argv) => {
    const statement = argv[argv.length - 1] ?? '';
    if (statement.includes('CREATE DATABASE')) {
      return { exitCode: 1, stderr: 'ERROR:  42501: permission denied to create database' };
    }
    return { exitCode: 0, stdout: '' };
  });
}

function inlineChecksWithRunner(
  checks: readonly Check[],
  runCommand: StepCheckBase['runCommand'],
): WizardCheckOptions {
  return {
    checks,
    context: {
      runCommand,
      deployRoot: '/tmp/app',
      bindPort: 3535,
      proxyRoot: '/tmp/proxy',
    },
  };
}

/** A `database-exists`-shaped scripted check, missing then (optionally) present. */
function scriptedDatabaseExists(outcomes: readonly CheckResult[]): { check: Check; calls: () => number } {
  return scriptedCheck('database-exists', outcomes);
}

const MISSING_DATABASE: CheckResult = {
  status: 'fail',
  detail: 'database "appdb" does not exist',
  remedy: 'Create it: createdb -h db.example.test -U appuser appdb. Migrations create tables, never the database itself.',
};

const DATABASE_PRESENT: CheckResult = { status: 'pass', detail: 'appdb' };

describe('runEnvWizard v2: offerDatabaseCreation', () => {
  it('--non-interactive without createDatabase never creates anything, and the check failure is still reported', async () => {
    const databaseExists = scriptedDatabaseExists([MISSING_DATABASE]);
    const psql = successfulCreate();

    const error = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      existing: V2_DATABASE,
      facts: facts(),
      portFree: async () => true,
      steps: stepsChecking('database', ['database-exists']),
      inlineChecks: inlineChecksWithRunner([databaseExists.check], psql.runCommand),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('does not exist');
    // The whole point: an unattended run with nobody to ask never gets to
    // issue a CREATE DATABASE at all.
    expect(psql.calls()).toBe(0);
    expect(databaseExists.calls()).toBe(1);
  });

  it('--non-interactive with createDatabase: true creates it, and the step passes on the re-run', async () => {
    const databaseExists = scriptedDatabaseExists([MISSING_DATABASE, DATABASE_PRESENT]);
    const psql = successfulCreate();

    const { values } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      nonInteractive: true,
      createDatabase: true,
      existing: V2_DATABASE,
      facts: facts(),
      portFree: async () => true,
      steps: stepsChecking('database', ['database-exists']),
      inlineChecks: inlineChecksWithRunner([databaseExists.check], psql.runCommand),
    });

    expect(values.get('POSTGRES_DB')).toBe('appdb');
    expect(psql.calls()).toBe(1);
    expect(databaseExists.calls()).toBe(2);
  });

  it('interactive: declining the prompt creates nothing and leaves the failure intact', async () => {
    const databaseExists = scriptedDatabaseExists([MISSING_DATABASE]);
    const psql = successfulCreate();

    const { ctx } = terminal([
      'db.example.test', 'appuser', 'pw-that-is-fine', 'appdb', '', // database fields
      'n', // "Create the database appdb now?" - declined
      'n', // "Correct them now?" - declined
    ]);

    const error = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      facts: facts(),
      portFree: async () => true,
      steps: stepsChecking('database', ['database-exists']),
      inlineChecks: inlineChecksWithRunner([databaseExists.check], psql.runCommand),
      ctx,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('does not exist');
    expect(psql.calls()).toBe(0);
    expect(databaseExists.calls()).toBe(1);
  });

  it('interactive: accepting creates it and the step re-runs', async () => {
    const databaseExists = scriptedDatabaseExists([MISSING_DATABASE, DATABASE_PRESENT]);
    const psql = successfulCreate();

    const { ctx, output, remaining } = terminal([
      'db.example.test', 'appuser', 'pw-that-is-fine', 'appdb', '', // database fields
      'y', // "Create the database appdb now?" - accepted
      '', '', '', '', '', // re-entry of the database step, all kept as-is
      'y', // JWT_SECRET: generate
      '', '', '', // the three resource suggestions
      'y', // review
    ]);

    const { values } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      facts: facts(),
      portFree: async () => true,
      steps: stepsChecking('database', ['database-exists']),
      inlineChecks: inlineChecksWithRunner([databaseExists.check], psql.runCommand),
      ctx,
    });

    expect(remaining()).toBe(0);
    expect(values.get('POSTGRES_DB')).toBe('appdb');
    expect(psql.calls()).toBe(1);
    expect(databaseExists.calls()).toBe(2);
    expect(output.text()).toContain('created appdb');
  });

  it('reports a failed creation and still surfaces the check failure, rather than silently passing', async () => {
    const databaseExists = scriptedDatabaseExists([MISSING_DATABASE]);
    const psql = refusedCreate();

    const { ctx, output } = terminal([
      'db.example.test', 'appuser', 'pw-that-is-fine', 'appdb', '', // database fields
      'y', // "Create the database appdb now?" - accepted, but refused server-side
      'n', // "Correct them now?" - declined
    ]);

    const error = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      facts: facts(),
      portFree: async () => true,
      steps: stepsChecking('database', ['database-exists']),
      inlineChecks: inlineChecksWithRunner([databaseExists.check], psql.runCommand),
      ctx,
    }).catch((caught: unknown) => caught);

    expect(psql.calls()).toBe(1);
    // The creation failure is reported...
    expect(output.text()).toContain('Could not create it');
    expect(output.text()).toContain('ALTER ROLE');
    // ...and the original check failure is still what the run reports, never
    // a silent pass.
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('does not exist');
    expect(databaseExists.calls()).toBe(1);
  });
});

describe('runEnvWizard v2: the catch-all step', () => {
  it('leaves an optional key out of the file when the answer is blank under --all', async () => {
    const { ctx, remaining } = terminal([
      'db.example.test', 'appuser', 'pw-that-is-fine', 'appdb', '',
      'n', 'a-perfectly-long-replacement-secret-value',
      '', '', '', // the three suggestions, in the resources step whatever section the template put them in
      '', // OTEL_DEBUG: blank skips it
      'y',
    ]);

    const { values, summary } = await runEnvWizard({
      specs: V2_SPECS,
      domain: 'app.example.test',
      all: true,
      facts: facts(),
      portFree: async () => true,
      ctx,
    });

    expect(remaining()).toBe(0);
    expect(values.has('OTEL_DEBUG')).toBe(false);
    expect(summary.find((row) => row.key === 'OTEL_DEBUG')?.source).toBe('skipped');
  });
});
