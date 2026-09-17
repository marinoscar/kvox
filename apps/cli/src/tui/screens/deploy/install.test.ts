import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildInstallSteps } from '../../../deploy/install.js';
import { metadataFor, type Suggestion } from '../../../deploy/env-metadata.js';
import { parseEnvExample, type EnvVarSpec } from '../../../deploy/env-spec.js';
import { unknownServerFacts } from '../../../deploy/server-facts.js';
import {
  DOMAIN_FIELD,
  INSTALL_WIZARD_STEPS,
  resolveSteps,
} from '../../../deploy/wizard/steps.js';
import type { CompletedCheck } from '../../../deploy/checks/index.js';
import {
  CONFIRM_DEFAULT_INDEX,
  MASKED_VALUE,
  confirmChoices,
  renderRows,
  wizardReduce,
} from '../../components/index.js';
import {
  ABORT_DIALOG,
  ALL_FIELD,
  CATCH_ALL_PAGE_SIZE,
  GROUPS_FIELD,
  INSTALL_CRON_FIELD,
  INTERNAL_DEFAULTS,
  PIPELINE_STEPS,
  PUBLIC_IP_FIELD,
  REVIEW_STEP_ID,
  STAGING_FIELD,
  WELCOME_STEP_ID,
  applyOptionMode,
  applySecretMode,
  checkItems,
  doneModel,
  ensureGeneratedSecrets,
  envAnswers,
  failedField,
  failedModel,
  formFieldsFor,
  formatDuration,
  groupsOf,
  installSteps,
  optionModeChoicesFor,
  optionModeField,
  CATCH_ALL_STEP_ID,
  isCatchAllStep,
  prepareStep,
  pipelineItems,
  railIndexFor,
  railSteps,
  reviewRows,
  secretModeField,
  stepCheckItems,
  welcomeChecks,
  withAnswer,
  type InstallAnswers,
  type InstallStep,
} from './install-model.js';

// =============================================================================
// The install wizard  (issue #131, epic #118)
// =============================================================================
//
// `ink-testing-library` is not a dependency of this package (see
// status.test.ts for why one was not added), so a screen is tested through the
// DATA it derives. That is not a workaround here: everything this issue is
// actually about — which steps exist and in what order, which step owns which
// key, that Back keeps what was typed, which field a failed check blames, that
// a review row cannot leak a secret, that the abort dialog opens on "no" — is
// a pure function in install-model.ts precisely so it can be asserted.
// =============================================================================

/**
 * A fixture template, not the real one.
 *
 * The real `.env.example` is already asserted against `steps.ts` by
 * deploy/wizard/steps.test.ts. What is checked HERE is the renderer's own
 * behaviour, and a fixture makes the expected answers visible in the test
 * rather than derived from a file that changes for unrelated reasons. Every
 * hostname and address below is an example.com placeholder.
 */
const TEMPLATE = [
  '# ------------------------------------------------------------',
  '# Application',
  '# ------------------------------------------------------------',
  'NODE_ENV=development',
  'APP_URL=http://localhost:3535',
  'PORT=3000',
  'APP_BIND_PORT=3535',
  'JOBS_WORKER_CONCURRENCY=2',
  'API_MEM_LIMIT=512M',
  'WEB_MEM_LIMIT=128M',
  '',
  '# ------------------------------------------------------------',
  '# Database',
  '# ------------------------------------------------------------',
  '# The database host.',
  'POSTGRES_HOST=localhost',
  'POSTGRES_PORT=5432',
  'POSTGRES_USER=postgres',
  'POSTGRES_PASSWORD=postgres',
  'POSTGRES_DB=appdb',
  'POSTGRES_SSL=false',
  '',
  '# ------------------------------------------------------------',
  '# JWT / Session',
  '# ------------------------------------------------------------',
  'JWT_SECRET=your-super-secret-key-min-32-characters-long',
  'COOKIE_SECRET=your-super-secret-cookie-key-min-32-chars',
  'SECRETS_ENCRYPTION_KEY=',
  '',
  '# ------------------------------------------------------------',
  '# OAuth',
  '# ------------------------------------------------------------',
  'GOOGLE_CLIENT_ID=your-client-id',
  'GOOGLE_CLIENT_SECRET=your-client-secret',
  'GOOGLE_CALLBACK_URL=http://localhost:3535/api/auth/google/callback',
  '',
  '# ------------------------------------------------------------',
  '# Admin',
  '# ------------------------------------------------------------',
  'INITIAL_ADMIN_EMAIL=admin@example.com',
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
  'S3_REGION=us-east-1',
  'S3_ENDPOINT=',
  'AWS_ACCESS_KEY_ID=',
  'AWS_SECRET_ACCESS_KEY=',
].join('\n');

const SPECS = parseEnvExample(TEMPLATE);

function stepsFor(options: Parameters<typeof installSteps>[1] = {}): InstallStep[] {
  return installSteps(SPECS, options);
}

const FULL = stepsFor({ all: true, groups: ['storage'] });

/**
 * The REAL template (#240, #241) — not the small fixture above.
 *
 * A fixture cannot regress when someone adds twenty keys to .env.example, so
 * the pagination properties below (no page over CATCH_ALL_PAGE_SIZE, a
 * section splitting into several pages, VAPID never being asked) are pinned
 * against the file the wizard actually reads, the same way
 * deploy/wizard/steps.test.ts and deploy/env-spec.test.ts already do.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_TEMPLATE_PATH = join(HERE, '..', '..', '..', '..', '..', '..', 'infra', 'compose', '.env.example');
const REAL_SPECS = parseEnvExample(readFileSync(REAL_TEMPLATE_PATH, 'utf8'));
const REAL_GROUPS = ['observability', 'storage'] as const;

function stepById(id: string, steps: readonly InstallStep[] = FULL): InstallStep {
  const found = steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

function fail(id: string, overrides: Partial<CompletedCheck> = {}): CompletedCheck {
  return {
    id,
    title: id,
    severity: 'required',
    status: 'fail',
    detail: 'nope',
    remedy: 'do the thing',
    durationMs: 1,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------

describe('installSteps', () => {
  it('walks Welcome and then steps.ts, in steps.ts order, ending on Review', () => {
    // Catch-all pages (#240) collapse back to the one step they came from:
    // this pins the ORDER of the wizard against steps.ts, and how many pages
    // the terminal needed for the last one is a separate question.
    const ids = FULL.map((step) => (isCatchAllStep(step.id) ? CATCH_ALL_STEP_ID : step.id));

    expect([...new Set(ids)]).toEqual([
      WELCOME_STEP_ID,
      ...INSTALL_WIZARD_STEPS.map((step) => step.id),
    ]);
    expect(FULL.at(-1)?.id).toBe(REVIEW_STEP_ID);
  });

  it('keeps the catch-all step only when the operator asked to review everything', () => {
    expect(stepsFor().some((step) => isCatchAllStep(step.id))).toBe(false);
    expect(stepsFor({ all: true }).some((step) => isCatchAllStep(step.id))).toBe(true);
  });

  it('drops the storage step when the group was not opted into', () => {
    // Not hidden by a condition here: its `fields` resolve to nothing, and a
    // step with nothing to ask is not shown.
    expect(stepsFor({ all: true }).map((step) => step.id)).not.toContain('storage');
    expect(stepsFor({ all: true, groups: groupsOf({ [GROUPS_FIELD]: 'storage' }) }).map((step) => step.id)).toContain(
      'storage',
    );
  });

  it('places every essential key of the template in exactly one step', () => {
    const essential = SPECS.filter((spec) => metadataFor(spec.key).essential === true);
    expect(essential.length).toBeGreaterThan(5);

    for (const spec of essential) {
      const owners = FULL.filter((step) => step.fields.includes(spec.key)).map((step) => step.id);
      expect(owners, spec.key).toHaveLength(1);
      expect(owners[0], spec.key).not.toBe('optional');
    }
  });

  it('never asks for a key that is fixed, derived or never written', () => {
    const asked = FULL.flatMap((step) => step.fields);

    expect(asked).not.toContain('NODE_ENV'); // fixed: production
    expect(asked).not.toContain('APP_URL'); // derived from the domain
    expect(asked).not.toContain('GOOGLE_CALLBACK_URL'); // derived from the domain
    expect(asked).not.toContain('TEST_AUTH_ENABLED'); // never written
  });

  it('asks the domain first and offers the public-IP override beside it', () => {
    const domain = stepById('domain');
    expect(domain.fields[0]).toBe(DOMAIN_FIELD);
    expect(domain.fields).toContain(PUBLIC_IP_FIELD);
  });

  it('asks the app name, the repository, the ref, the groups and the depth on Welcome', () => {
    expect(stepById(WELCOME_STEP_ID).fields).toEqual([
      '__name',
      '__repo',
      '__ref',
      GROUPS_FIELD,
      ALL_FIELD,
    ]);
  });

  it('adds the TLS choice and the renewal cron to the resources step', () => {
    expect(stepById('resources').fields).toEqual([
      'APP_BIND_PORT',
      'JOBS_WORKER_CONCURRENCY',
      'API_MEM_LIMIT',
      'WEB_MEM_LIMIT',
      STAGING_FIELD,
      INSTALL_CRON_FIELD,
    ]);
  });

  it('gives the rail one entry per step', () => {
    expect(railSteps(FULL)).toHaveLength(FULL.length);
    expect(railSteps(FULL)[0]).toEqual({ id: WELCOME_STEP_ID, title: 'Welcome' });
  });
});

describe('Back', () => {
  it('keeps every answer: the reducer moves an index and has no room for them', () => {
    let answers: InstallAnswers = INTERNAL_DEFAULTS;
    answers = withAnswer(answers, DOMAIN_FIELD, 'app.example.com');
    answers = withAnswer(answers, 'POSTGRES_HOST', 'db.example.com');
    const before = answers;

    const rail = railSteps(FULL);
    let index = 0;
    for (const action of [{ type: 'next' as const }, { type: 'next' as const }, { type: 'back' as const }]) {
      const transition = wizardReduce(index, rail, action);
      expect(transition.kind).toBe('move');
      index = transition.index;
    }

    expect(index).toBe(1);
    // Identity, not equality: there is no action that could have rebuilt it.
    expect(answers).toBe(before);
    expect(answers[DOMAIN_FIELD]).toBe('app.example.com');
    expect(answers['POSTGRES_HOST']).toBe('db.example.com');
  });

  it('cancels out of the wizard from Welcome rather than moving', () => {
    expect(wizardReduce(0, railSteps(FULL), { type: 'back' }).kind).toBe('cancel');
  });
});

describe('formFieldsFor', () => {
  it('pre-fills no database host — the template default is a placeholder nobody chose', () => {
    const fields = formFieldsFor(stepById('database'), { specs: SPECS, answers: {} });
    const host = fields.find((field) => field.key === 'POSTGRES_HOST');

    expect(host?.kind).toBe('text');
    expect(host?.kind === 'text' ? host.placeholder : 'unset').toBe('');
    // A non-essential key keeps its default: 5432 is a real answer.
    const port = fields.find((field) => field.key === 'POSTGRES_PORT');
    expect(port?.kind === 'text' ? port.placeholder : undefined).toBe('5432');
  });

  it('draws a true/false key as a list, not a text box', () => {
    const ssl = formFieldsFor(stepById('database'), { specs: SPECS, answers: {} }).find(
      (field) => field.key === 'POSTGRES_SSL',
    );

    expect(ssl?.kind).toBe('select');
  });

  it('masks every secret it asks for', () => {
    const database = formFieldsFor(stepById('database'), { specs: SPECS, answers: {} });
    const password = database.find((field) => field.key === 'POSTGRES_PASSWORD');

    expect(password?.kind === 'text' ? password.secret : undefined).toBe(true);
  });

  it('offers generate-or-paste for each generated secret, defaulting to generate', () => {
    const fields = formFieldsFor(stepById('secrets'), { specs: SPECS, answers: {} });

    for (const key of ['JWT_SECRET', 'COOKIE_SECRET', 'SECRETS_ENCRYPTION_KEY']) {
      const mode = fields.find((field) => field.key === secretModeField(key));
      expect(mode?.kind, key).toBe('select');
      expect(mode?.kind === 'select' ? mode.choices[0]?.value : undefined, key).toBe('generate');

      const value = fields.find((field) => field.key === key);
      expect(value?.kind === 'text' ? value.secret : undefined, key).toBe(true);
    }
  });

  it('carries a server-derived suggestion with its reason, so Tab accepts a value that was seen', () => {
    const suggestion: Suggestion = { value: '3536', reason: '3535 is used by demo' };
    const port = formFieldsFor(stepById('resources'), {
      specs: SPECS,
      answers: {},
      suggestions: { APP_BIND_PORT: suggestion },
    }).find((field) => field.key === 'APP_BIND_PORT');

    expect(port?.kind === 'text' ? port.suggestion : undefined).toEqual(suggestion);
    expect(port?.kind === 'text' ? port.placeholder : undefined).toBe('3536');
  });

  it('lets a blank answer through on an optional step, and never on a required one', () => {
    const storage = formFieldsFor(stepById('storage'), { specs: SPECS, answers: {} });
    const admin = formFieldsFor(stepById('admin'), { specs: SPECS, answers: {} });

    const bucket = storage.find((field) => field.key === 'S3_BUCKET');
    expect(bucket?.kind === 'text' ? bucket.validate?.('') : 'missing').toBeUndefined();

    const email = admin.find((field) => field.key === 'INITIAL_ADMIN_EMAIL');
    expect(email?.kind === 'text' ? email.validate?.('') : undefined).toBeDefined();
    // example.org, not example.com: `rejectPlaceholder` treats an
    // example.com address as the template's own placeholder, which it is.
    expect(email?.kind === 'text' ? email.validate?.('admin@example.org') : 'x').toBeUndefined();
  });

  it('validates the domain as a bare hostname', () => {
    const domain = formFieldsFor(stepById('domain'), { specs: SPECS, answers: {} })[0];

    expect(domain?.kind === 'text' ? domain.validate?.('https://app.example.com/x') : undefined).toBeDefined();
    expect(domain?.kind === 'text' ? domain.validate?.('app.example.com') : 'x').toBeUndefined();
  });
});

describe('generated secrets', () => {
  const step = stepById('secrets');
  let counter = 0;
  const generate = (): string => `generated-${(counter += 1)}`;

  it('fills every generate-mode secret when the step opens, and leaves a typed one alone', () => {
    counter = 0;
    const filled = ensureGeneratedSecrets({ JWT_SECRET: 'mine' }, step, SPECS, generate);

    expect(filled['JWT_SECRET']).toBe('mine');
    expect(filled['COOKIE_SECRET']).toBe('generated-1');
    expect(filled['SECRETS_ENCRYPTION_KEY']).toBe('generated-2');
    expect(filled[secretModeField('COOKIE_SECRET')]).toBe('generate');
  });

  it('clears the minted value when the operator chooses to paste their own', () => {
    counter = 0;
    const filled = ensureGeneratedSecrets({}, step, SPECS, generate);
    const pasting = applySecretMode(filled, 'JWT_SECRET', 'paste', generate);

    expect(pasting['JWT_SECRET']).toBe('');
    expect(pasting[secretModeField('JWT_SECRET')]).toBe('paste');

    const back = applySecretMode(pasting, 'JWT_SECRET', 'generate', generate);
    expect(back['JWT_SECRET']).not.toBe('');
  });
});

describe('envAnswers', () => {
  it('drops every wizard-internal field, so none of them reaches the .env', () => {
    const answers = {
      ...INTERNAL_DEFAULTS,
      [DOMAIN_FIELD]: 'app.example.com',
      [PUBLIC_IP_FIELD]: '203.0.113.10',
      [ALL_FIELD]: 'true',
      [secretModeField('JWT_SECRET')]: 'generate',
      POSTGRES_HOST: 'db.example.com',
      JWT_SECRET: 'a-perfectly-long-replacement-secret-value',
    };

    expect([...envAnswers(answers).keys()]).toEqual(['POSTGRES_HOST', 'JWT_SECRET']);
  });

  it('skips a blank answer rather than writing the key empty', () => {
    expect(envAnswers({ S3_ENDPOINT: '', S3_REGION: 'us-east-1' }).has('S3_ENDPOINT')).toBe(false);
  });
});

describe('a failing check maps to the field that caused it', () => {
  it.each([
    ['dns-resolves', 'domain', DOMAIN_FIELD],
    ['dns-points-here', 'domain', DOMAIN_FIELD],
    ['database-reachable', 'database', 'POSTGRES_HOST'],
    ['database-credentials', 'database', 'POSTGRES_PASSWORD'],
    ['database-exists', 'database', 'POSTGRES_DB'],
    ['database-privileges', 'database', 'POSTGRES_USER'],
  ])('%s sends the operator back to %s / %s', (id, stepId, field) => {
    expect(failedField([fail(id)], stepById(stepId))).toBe(field);
  });

  it('blames the first failure when several fail at once', () => {
    expect(failedField([fail('database-exists'), fail('database-reachable')], stepById('database'))).toBe(
      'POSTGRES_DB',
    );
  });

  it('falls back to the step\'s first field for an unmapped check, never advancing past it', () => {
    expect(failedField([fail('something-new')], stepById('database'))).toBe('POSTGRES_HOST');
  });

  it('is undefined when nothing failed, so a warn does not hold the wizard up', () => {
    expect(failedField([fail('dns-points-here', { status: 'warn' })], stepById('domain'))).toBeUndefined();
  });
});

describe('the live doctor on Welcome', () => {
  it('runs the required checks but not devnet, which the install itself creates', () => {
    const ids = welcomeChecks().map((check) => check.id);

    expect(ids.length).toBeGreaterThan(5);
    expect(ids).not.toContain('devnet-network');
    expect(welcomeChecks().every((check) => check.severity === 'required')).toBe(true);
  });

  it('lists every check from the first frame, with one in flight and the rest pending', () => {
    const checks = welcomeChecks().slice(0, 3);
    const results: CompletedCheck[] = [
      { ...fail(checks[0]?.id ?? '', { status: 'pass' }), title: checks[0]?.title ?? '' },
    ];
    const items = checkItems(checks, results, true);

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.status)).toEqual(['pass', 'running', 'pending']);
  });

  it('carries the remedy of a failure through to the row', () => {
    const checks = welcomeChecks().slice(0, 1);
    const id = checks[0]?.id ?? '';
    const items = checkItems(checks, [fail(id)], false);

    expect(items[0]?.remedy).toBe('do the thing');
  });
});

describe('stepCheckItems', () => {
  it('shows a step\'s declared checks from the first frame, pending until they run', () => {
    const items = stepCheckItems(stepById('domain'), [], true);

    expect(items.map((item) => item.id)).toEqual(['dns-resolves', 'dns-points-here']);
    expect(items.map((item) => item.status)).toEqual(['running', 'pending']);
  });

  it('falls back to the results themselves for a step that declares no registry ids', () => {
    // The storage step's `onLeave` is one ad-hoc probe, not registry entries,
    // so listing "all of them" up front is not possible — and its single warn
    // must still reach the screen.
    const items = stepCheckItems(stepById('storage'), [
      fail('storage-reachable', { status: 'warn', severity: 'recommended', title: 'Object storage reachable' }),
    ], false);

    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('warn');
    expect(items[0]?.remedy).toBe('do the thing');
  });
});

describe('reviewRows', () => {
  const answers: InstallAnswers = {
    ...INTERNAL_DEFAULTS,
    [DOMAIN_FIELD]: 'app.example.com',
    POSTGRES_HOST: 'db.example.com',
    POSTGRES_USER: 'appuser',
    POSTGRES_PASSWORD: 'hunter2-not-in-any-frame',
    POSTGRES_DB: 'appdb',
    JWT_SECRET: 'jwt-secret-that-must-never-be-rendered',
    COOKIE_SECRET: 'cookie-secret-that-must-never-be-rendered',
    GOOGLE_CLIENT_SECRET: 'oauth-secret-that-must-never-be-rendered',
    GOOGLE_CLIENT_ID: 'a-client-id',
    INITIAL_ADMIN_EMAIL: 'someone@example.com',
    APP_BIND_PORT: '3536',
  };

  const rows = reviewRows({
    specs: SPECS,
    answers,
    suggestions: { APP_BIND_PORT: { value: '3536', reason: '3535 is used by demo' } },
    facts: unknownServerFacts(),
    name: 'demo',
    deployRoot: '/opt/infra/apps/demo',
    repoUrl: 'https://example.com/acme/demo.git',
    ref: 'main',
    proxyContainer: 'proxy-nginx-1',
  });

  it('masks every secret key', () => {
    for (const row of rows) {
      if (metadataFor(row.key).secret !== true) continue;
      expect(row.masked, row.key).toBe(true);
    }
    // And at least one really was a secret, so the loop is not vacuous.
    expect(rows.filter((row) => row.masked === true).length).toBeGreaterThanOrEqual(4);
  });

  it('cannot leak a secret even if a screen renders every row it was given', () => {
    const rendered = renderRows(rows, 120);
    const text = rendered.map((row) => `${row.label}${row.value}${row.note ?? ''}`).join('\n');

    for (const secret of [
      'hunter2-not-in-any-frame',
      'jwt-secret-that-must-never-be-rendered',
      'cookie-secret-that-must-never-be-rendered',
      'oauth-secret-that-must-never-be-rendered',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain(MASKED_VALUE);
  });

  it('shows the values derived from the domain, which are never asked for', () => {
    expect(rows.find((row) => row.key === 'APP_URL')?.value).toBe('https://app.example.com');
    expect(rows.find((row) => row.key === 'GOOGLE_CALLBACK_URL')?.value).toBe(
      'https://app.example.com/api/auth/google/callback',
    );
  });

  it('shows a suggested value with the reason it was suggested', () => {
    expect(rows.find((row) => row.key === 'APP_BIND_PORT')?.note).toBe('3535 is used by demo');
  });

  it('names the compose project and the proxy container the install will touch', () => {
    expect(rows.find((row) => row.key === 'App / compose project')?.value).toBe('demo');
    expect(rows.find((row) => row.key === 'Proxy container')?.value).toBe('proxy-nginx-1');
  });

  it('states the TLS endpoint and whether the renewal cron is installed', () => {
    expect(rows.find((row) => row.key === 'TLS')?.value).toContain('production');
    expect(rows.find((row) => row.key === 'Renewal cron')?.value).toBe('installed');

    const staging = reviewRows({
      specs: SPECS,
      answers: { ...answers, [STAGING_FIELD]: 'true', [INSTALL_CRON_FIELD]: 'false' },
      facts: unknownServerFacts(),
      name: 'demo',
      deployRoot: '/opt/infra/apps/demo',
      repoUrl: 'https://example.com/acme/demo.git',
      ref: 'main',
      proxyContainer: 'proxy-nginx-1',
    });
    expect(staging.find((row) => row.key === 'TLS')?.value).toContain('staging');
    expect(staging.find((row) => row.key === 'Renewal cron')?.value).toBe('not installed');
  });
});

describe('the running view', () => {
  it('lists the real pipeline, in its real order', () => {
    expect(PIPELINE_STEPS.map((step) => step.id)).toEqual(
      buildInstallSteps().map((step) => step.id),
    );
  });

  it('shows every step from the first frame, with a duration once one finishes', () => {
    const items = pipelineItems([
      { id: 'preflight', title: 'Check prerequisites', outcome: 'ok', durationMs: 2_400 },
      { id: 'network', title: 'Ensure the network', outcome: 'running' },
    ]);

    expect(items).toHaveLength(PIPELINE_STEPS.length);
    expect(items[0]?.status).toBe('pass');
    expect(items[0]?.detail).toBe('2s');
    expect(items[1]?.status).toBe('running');
    expect(items.at(-1)?.status).toBe('pending');
  });

  it('reports a skipped step as skipped rather than as a failure', () => {
    const items = pipelineItems([
      { id: 'seed', title: 'Seed', outcome: 'skipped', detail: 'skipped with --skip-seed' },
    ]);

    expect(items.find((item) => item.id === 'seed')?.status).toBe('skip');
  });

  it.each([
    [860, '860ms'],
    [41_000, '41s'],
    [124_000, '2m 04s'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('the abort dialog', () => {
  it('opens on cancel, so a stray Enter cannot kill a running build', () => {
    const choices = confirmChoices(ABORT_DIALOG.confirmLabel, ABORT_DIALOG.cancelLabel);

    expect(choices[CONFIRM_DEFAULT_INDEX]?.value).toBe(false);
    expect(choices[CONFIRM_DEFAULT_INDEX]?.label).toBe('No, go back');
  });

  it('says what an interrupted install leaves behind, and that re-running resumes', () => {
    expect(ABORT_DIALOG.danger).toBe(true);
    expect(ABORT_DIALOG.detail.join(' ')).toContain('partial deployment');
    expect(ABORT_DIALOG.detail.join(' ')).toContain('resume');
  });
});

describe('the Done and Failed models', () => {
  it('carries the domain, the revision and the journal path, and the login instruction', () => {
    const model = doneModel({
      domain: 'app.example.com',
      commitSha: '0123456789abcdef0123',
      journalPath: '/opt/infra/apps/demo/logs/install-1.log',
      deployRoot: '/opt/infra/apps/demo',
      name: 'demo',
      nextStep: 'Log in at https://app.example.com as someone@example.com to claim the Admin role.',
    });

    expect(model.rows.find((row) => row.key === 'Domain')?.value).toBe('app.example.com');
    expect(model.rows.find((row) => row.key === 'Revision')?.value).toBe('0123456789ab');
    expect(model.rows.find((row) => row.key === 'Journal')?.value).toBe(
      '/opt/infra/apps/demo/logs/install-1.log',
    );
    expect(model.nextStep).toContain('claim the Admin role');
  });

  it('names the failed step, the journal, and offers a resume rather than a restart', () => {
    const model = failedModel({
      stepId: 'migrate',
      message: 'Apply migrations failed: exit 1',
      journalPath: '/opt/infra/apps/demo/logs/install-1.log',
      domain: 'app.example.com',
    });

    expect(model.rows.find((row) => row.key === 'Step')?.value).toBe('Apply migrations');
    expect(model.rows.find((row) => row.key === 'Journal')?.value).toBe(
      '/opt/infra/apps/demo/logs/install-1.log',
    );
    expect(model.rows.find((row) => row.key === 'Domain')?.value).toBe('app.example.com');
    expect(model.actionLabel).toBe('Re-run install (resumes)');
  });

  it('says so plainly when the run stopped before a journal existed', () => {
    const model = failedModel({ message: 'boom' });

    expect(model.rows.find((row) => row.key === 'Journal')?.value).toBe('(not opened)');
  });
});

describe('the catch-all step', () => {
  // The catch-all is now SEVERAL steps, one per template section (#240), so
  // this reaches for the first page rather than a step called `optional`.
  // `PORT` is in the first section, which is why these cases still find it.
  const step = FULL.find((candidate) => isCatchAllStep(candidate.id));
  if (step === undefined) throw new Error('no catch-all page');

  it('offers keep, edit or skip per key, defaulting to keep', () => {
    const fields = formFieldsFor(step, { specs: SPECS, answers: {} });
    const mode = fields.find((field) => field.key === optionModeField('PORT'));

    expect(mode?.kind).toBe('select');
    expect(mode?.kind === 'select' ? mode.choices.map((choice) => choice.value) : []).toEqual([
      'keep',
      'edit',
      'skip',
    ]);
  });

  it("puts the template's own value behind `keep`, so the review shows what is written", () => {
    const prepared = prepareStep({}, step, SPECS);

    expect(prepared[optionModeField('PORT')]).toBe('keep');
    expect(prepared['PORT']).toBe('3000');
    expect(envAnswers(prepared).get('PORT')).toBe('3000');
  });

  it('leaves the key out of the file entirely on skip', () => {
    const skipped = applyOptionMode(prepareStep({}, step, SPECS), 'PORT', 'skip', undefined);

    expect(skipped['PORT']).toBe('');
    expect(envAnswers(skipped).has('PORT')).toBe(false);
  });

  it('does not touch a step that is not the catch-all', () => {
    const prepared = prepareStep({}, stepById('database'), SPECS);

    expect(prepared[optionModeField('POSTGRES_HOST')]).toBeUndefined();
  });
});

// =============================================================================
// Catch-all pagination against the REAL template (#240)
// =============================================================================
//
// `installSteps({ all: true, ... })` is the wizard's own resolution path, so
// these run it against infra/compose/.env.example rather than a fixture -
// exactly the reason a real multi-page section (Background Job Queue, with
// eleven keys no earlier step claims) exists to exercise here without being
// invented for the test.
// =============================================================================

/** What `metadataFor` says an unpaginated catch-all would have asked - the
 *  same `never`/`fixed`/`derive` exclusions `installSteps` applies before
 *  handing a step's fields to `catchAllPages`. Recomputed independently here
 *  (rather than importing the private `isAsked`) so this test is a genuine
 *  second opinion, not a restatement of the same line of code. */
function isAskedForTest(metadata: ReturnType<typeof metadataFor>): boolean {
  return metadata.never !== true && metadata.fixed === undefined && metadata.derive === undefined;
}

describe('catch-all pagination against the real template (#240)', () => {
  const paginated = installSteps(REAL_SPECS, { all: true, groups: REAL_GROUPS });
  const pages = paginated.filter((step) => isCatchAllStep(step.id));
  const byKey = new Map(REAL_SPECS.map((spec) => [spec.key, spec]));

  const resolvedCatchAll = resolveSteps(INSTALL_WIZARD_STEPS, REAL_SPECS, { groups: [...REAL_GROUPS] }).find(
    (entry) => entry.step.id === CATCH_ALL_STEP_ID,
  );
  if (resolvedCatchAll === undefined) throw new Error('steps.ts has no catch-all step');
  const expectedFields = resolvedCatchAll.fields.filter((ref) => isAskedForTest(metadataFor(ref)));

  it('produces more than one page against the real template, so these cases prove something', () => {
    expect(pages.length).toBeGreaterThan(1);
  });

  it('never exceeds CATCH_ALL_PAGE_SIZE fields on any generated page', () => {
    for (const page of pages) {
      expect(page.fields.length, page.id).toBeLessThanOrEqual(CATCH_ALL_PAGE_SIZE);
    }
  });

  it('never mixes two sections on one page', () => {
    for (const page of pages) {
      const sections = new Set(page.fields.map((key) => byKey.get(key)?.section));
      expect(sections.size, page.id).toBe(1);
      expect([...sections][0], page.id).toBe(page.page?.section);
    }
  });

  it('splits a section with more than CATCH_ALL_PAGE_SIZE keys into several pages, all naming that section', () => {
    const bySection = new Map<string, string[]>();
    for (const key of expectedFields) {
      const section = byKey.get(key)?.section ?? '';
      bySection.set(section, [...(bySection.get(section) ?? []), key]);
    }
    const overflowing = [...bySection.entries()].filter(([, keys]) => keys.length > CATCH_ALL_PAGE_SIZE);
    // Guards against a future template edit quietly removing the one section
    // big enough to exercise this - Background Job Queue, at the time of
    // writing, but named nowhere above so this does not pin that name.
    expect(overflowing.length).toBeGreaterThan(0);

    for (const [section] of overflowing) {
      const sectionPages = pages.filter((page) => page.page?.section === section);
      expect(sectionPages.length, section).toBeGreaterThan(1);
    }
  });

  it('numbers every page 1..total, and every page reports the SAME total', () => {
    expect(pages.map((page) => page.page?.total)).toEqual(pages.map(() => pages.length));
    expect(pages.map((page) => page.page?.index)).toEqual(pages.map((_, index) => index + 1));
  });

  it('gives every page a unique, catch-all id, with optional: true surviving onto it', () => {
    const ids = pages.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const page of pages) {
      expect(isCatchAllStep(page.id)).toBe(true);
      expect(page.optional).toBe(true);
    }
  });

  it('the union of every page, in order, is exactly what the unpaginated catch-all would have asked', () => {
    const union = pages.flatMap((page) => page.fields);

    expect(union).toEqual(expectedFields);
    // Nothing duplicated across pages, stated separately from the ordered
    // equality above so a future refactor cannot pass this by accident.
    expect(new Set(union).size).toBe(union.length);
  });

  it('generates no catch-all page at all with all: false', () => {
    const essentialOnly = installSteps(REAL_SPECS, { all: false, groups: REAL_GROUPS });

    expect(essentialOnly.some((step) => isCatchAllStep(step.id))).toBe(false);
  });

  it('are never asked: the three VAPID_* keys never appear as a field on any generated step (#241)', () => {
    // Through installSteps - the wizard's own step-resolution path - rather
    // than by reading ENV_METADATA back, so this proves the wizard actually
    // stops asking rather than merely that the registry says it should.
    const asked = new Set(paginated.flatMap((step) => step.fields));

    for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
      expect(asked.has(key), key).toBe(false);
    }
  });
});

function fakeRailStep(id: string, title: string): InstallStep {
  return { id, title, fields: [] };
}

describe('railSteps and railIndexFor (#240)', () => {
  it('collapses only ADJACENT steps with the same title', () => {
    const steps: InstallStep[] = [
      fakeRailStep('a1', 'Alpha'),
      fakeRailStep('a2', 'Alpha'),
      fakeRailStep('b1', 'Beta'),
      // Alpha again, but not adjacent to a1/a2 - must NOT collapse with them.
      fakeRailStep('a3', 'Alpha'),
    ];

    const rail = railSteps(steps);

    expect(rail.map((entry) => entry.id)).toEqual(['a1', 'b1', 'a3']);
    // The number of distinct adjacent titles: Alpha, Beta, Alpha-again.
    expect(rail).toHaveLength(3);
  });

  it('maps every step index to its rail entry - the first, the last, and every page of a multi-page catch-all alike', () => {
    const paginated = installSteps(REAL_SPECS, { all: true, groups: REAL_GROUPS });
    const rail = railSteps(paginated);

    expect(railIndexFor(paginated, 0)).toBe(0);
    expect(railIndexFor(paginated, paginated.length - 1)).toBe(rail.length - 1);

    const pageIndices = paginated
      .map((step, index) => ({ id: step.id, index }))
      .filter(({ id }) => isCatchAllStep(id));
    // Otherwise this proves nothing: the real template needs more than one
    // catch-all page for "every page maps to the same rail index" to mean
    // anything.
    expect(pageIndices.length).toBeGreaterThan(1);

    const railIndices = new Set(pageIndices.map(({ index }) => railIndexFor(paginated, index)));
    expect(railIndices.size).toBe(1);
  });
});

describe('optionModeChoicesFor (#240)', () => {
  const withTemplateValue: EnvVarSpec = {
    key: 'PORT',
    section: 'Application',
    defaultValue: '3000',
    help: '',
    optional: false,
    line: 1,
  };
  const optionalNoDefault: EnvVarSpec = {
    key: 'S3_ENDPOINT',
    section: 'Storage',
    defaultValue: '',
    help: '',
    optional: true,
    line: 1,
  };
  const requiredButBlank: EnvVarSpec = {
    key: 'SECRETS_ENCRYPTION_KEY',
    section: 'JWT / Session',
    defaultValue: '',
    help: '',
    optional: false,
    line: 1,
  };

  it('labels Keep / Edit / Skip for a key the template ships with a real value', () => {
    expect(optionModeChoicesFor(withTemplateValue).map((choice) => choice.label)).toEqual([
      'Keep',
      'Edit',
      'Skip',
    ]);
  });

  it('labels Leave unset / Set a value / Skip for a key marked optional', () => {
    expect(optionModeChoicesFor(optionalNoDefault).map((choice) => choice.label)).toEqual([
      'Leave unset',
      'Set a value',
      'Skip',
    ]);
  });

  it('labels Leave unset / Set a value / Skip for a required key the template ships with no value', () => {
    expect(optionModeChoicesFor(requiredButBlank).map((choice) => choice.label)).toEqual([
      'Leave unset',
      'Set a value',
      'Skip',
    ]);
  });

  it('keeps the values exactly keep/edit/skip in every case - the mode is the contract, the label is only the wording', () => {
    for (const spec of [withTemplateValue, optionalNoDefault, requiredButBlank, undefined]) {
      expect(optionModeChoicesFor(spec).map((choice) => choice.value)).toEqual(['keep', 'edit', 'skip']);
    }
  });
});

describe('groupsOf', () => {
  it('is empty until the operator opts in on Welcome', () => {
    expect(groupsOf({})).toEqual([]);
    expect(groupsOf({ [GROUPS_FIELD]: '' })).toEqual([]);
  });

  it('reads the comma-separated list the Welcome step records', () => {
    expect(groupsOf({ [GROUPS_FIELD]: 'storage' })).toEqual(['storage']);
  });
});
