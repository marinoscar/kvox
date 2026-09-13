import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CLI_NAME } from '../branding.js';
import { generateBase64Key } from '../deploy/env-metadata.js';
import {
  diffEnv,
  parseEnvExample,
  parseEnvFile,
  serializeEnvFile,
  type EnvVarSpec,
} from '../deploy/env-spec.js';
import { runEnvWizard } from '../deploy/env-wizard.js';
import { PreconditionError, UsageError } from '../errors.js';
import { canPrompt, confirm, type PromptContext } from '../prompt.js';
import {
  COMPOSE_DB_HOST,
  ENV_FILE_RELATIVE_PATH,
  ENV_TEMPLATE_RELATIVE_PATH,
  GENERATED_KEYS,
  REQUIRED_TO_RUN,
  findRepoRoot,
  isComposeInternalHost,
  localMetadataFor,
  localSpecs,
  unattendedLocalAnswers,
} from './local-profile.js';

// =============================================================================
// `appctl init` - the local environment bootstrap  (issue #344, epic #341)
// =============================================================================
//
// A fresh clone of this template cannot be started. `infra/compose/.env` does
// not exist, `cp .env.example .env` produces a file whose Google credentials
// are placeholders and whose three secrets are the literal string
// `your-super-secret-key-min-32-characters-long`, and the API's first act on
// boot is to refuse that. The gap between "cloned" and "running" is about
// thirty-four variables, three `openssl rand -base64 32` invocations and a
// piece of knowledge (Google OAuth is not optional) that is written down in a
// comment in a CI workflow.
//
// THIS COMMAND IS THE DEPLOY WIZARD POINTED AT THIS MACHINE. It parses the
// same template, runs the same wizard, generates keys with the same CSPRNG
// helper and writes the file with the same serialiser; `init/local-profile.ts`
// is the only new logic, and it is a page of differences rather than a second
// implementation. A fork that adds a variable to `.env.example` gets it in
// both paths, with no edit here.
//
// IT WRITES EXACTLY ONE FILE, AT 0600, AND NEVER `.env.example`. The template
// is a validated artefact - `deploy/env-spec.test.ts` reads it and fails on a
// duplicate declaration, including a commented one - so everything this
// command wants to say about a variable is said in the PROMPT, not in the file
// the prompt is parsed from.
// =============================================================================

export interface InitOptions {
  /** Where to start looking for the repository root. */
  cwd?: string | undefined;
  /** Skips the search when given. */
  repoRoot?: string | undefined;
  /** Overwrite an existing .env, keeping the values already in it. */
  force?: boolean | undefined;
  /** Never prompt: generate the secrets, take every default, leave OAuth blank. */
  nonInteractive?: boolean | undefined;
  /** Supplies INITIAL_ADMIN_EMAIL without a prompt. */
  adminEmail?: string | undefined;
  /** Review every variable, not only the eight that are asked by default. */
  all?: boolean | undefined;
  promptContext?: PromptContext | undefined;
  stderr?: { write(chunk: string): unknown } | undefined;
}

export interface InitResult {
  /** Absolute path of the file that was written. */
  envPath: string;
  /** Number of variables in it. */
  variables: number;
  /** Keys whose value this run generated. Never their values. */
  generated: string[];
  /** Keys the application needs that came out empty. */
  missingRequired: string[];
}

/** Reads and parses the template, failing with something actionable. */
function readTemplate(root: string): { path: string; specs: EnvVarSpec[] } {
  const path = join(root, ENV_TEMPLATE_RELATIVE_PATH);

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    throw new PreconditionError(
      `Cannot read the environment template at ${path}.\n` +
        `${CLI_NAME} init derives its questions from that file, so it cannot run without it.`,
    );
  }

  const specs = parseEnvExample(contents);
  if (specs.length === 0) {
    throw new PreconditionError(
      `${path} declares no variables, so there is nothing to configure.`,
    );
  }

  return { path, specs };
}

/**
 * What a --force run would actually do to the file that is already there.
 *
 * Reuses `diffEnv` rather than describing the file in its own way - it is the
 * same comparison `deploy update` makes when a new revision adds variables -
 * but then FILTERS IT THROUGH THE LOCAL PROFILE, because `diffEnv` answers
 * "what is in the template and not in the file" and that is not the same
 * question. A commented-out template entry is an optional variable nothing
 * writes, and a grouped one belongs to a compose overlay this command does not
 * turn on. Listing those as "would be added" would be a promise the run does
 * not keep, and thirty names is a lot of noise to hide the two that matter.
 */
function describeExisting(
  specs: readonly EnvVarSpec[],
  current: ReadonlyMap<string, string>,
): string[] {
  const { missing, unknown } = diffEnv(specs, current);
  const lines: string[] = [];

  const additions = missing.filter((spec) => {
    if (spec.optional) return false;
    const metadata = localMetadataFor(spec.key);
    return metadata.never !== true && metadata.group === undefined;
  });

  // The wizard deletes these outright, whatever the template says.
  const removals = [...current.keys()].filter(
    (key) => localMetadataFor(key).never === true,
  );

  lines.push(`  ${current.size} variable(s) are set in it.`);

  if (additions.length > 0) {
    lines.push(`  ${additions.length} variable(s) would be added:`);
    for (const spec of additions) lines.push(`    ${spec.key}`);
  } else {
    lines.push('  Nothing would be added: every variable it needs is already there.');
  }

  if (removals.length > 0) {
    lines.push(
      `  ${removals.length} variable(s) would be removed: ${removals.join(', ')}`,
    );
  }

  if (unknown.length > 0) {
    lines.push(
      `  ${unknown.length} variable(s) are not in the template and would be kept untouched.`,
    );
  }

  lines.push('  Every value already set would be kept, secrets included.');

  return lines;
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const stderr = options.stderr ?? process.stderr;
  const write = (line: string): void => {
    stderr.write(`${line}\n`);
  };

  const root =
    options.repoRoot ?? findRepoRoot(options.cwd ?? process.cwd()) ?? undefined;

  if (root === undefined) {
    throw new PreconditionError(
      `Could not find ${ENV_TEMPLATE_RELATIVE_PATH} in this directory or any parent.\n` +
        `Run ${CLI_NAME} init from inside a checkout of this repository, or pass --repo-root <path>.`,
    );
  }

  const { path: templatePath, specs } = readTemplate(root);
  const envPath = join(root, ENV_FILE_RELATIVE_PATH);
  const exists = existsSync(envPath);
  const current = exists ? parseEnvFile(readFileSync(envPath, 'utf8')) : undefined;

  write('');
  write(`  Bootstrapping ${envPath}`);
  write(`  Questions come from ${templatePath}`);

  // ---------------------------------------------------------------------------
  // 1. Never clobber silently.
  // ---------------------------------------------------------------------------
  // A .env holds the only copy of three generated secrets and a database
  // password. Overwriting it is not undoable, and it is precisely the file
  // somebody has just spent ten minutes getting right.
  if (exists && options.force !== true) {
    write('');
    write(`  ${envPath} already exists. Nothing has been changed.`);

    const plan = describeExisting(specs, current as ReadonlyMap<string, string>);
    const interactive = options.nonInteractive !== true && canPrompt(options.promptContext);

    if (interactive) {
      write('');
      const show = await confirm(
        '  Show what init would change?',
        { defaultValue: true },
        options.promptContext,
      );
      if (show) {
        write('');
        for (const line of plan) write(line);
      }
    } else {
      write('');
      for (const line of plan) write(line);
    }

    throw new UsageError(
      `Refusing to overwrite ${envPath}. Re-run with --force to fill in what is missing (existing values, including secrets, are kept).`,
    );
  }

  // Fail here rather than three questions into a wizard nobody can answer.
  // `prompt()` refuses without a TTY, correctly, but its message is the
  // general one ("supply the value on the command line") and this command's
  // answer is a specific flag - said before anything is printed, not after a
  // page of help text for a question that was never going to be asked.
  if (options.nonInteractive !== true && !canPrompt(options.promptContext)) {
    throw new UsageError(
      `${CLI_NAME} init needs an interactive terminal to ask about the database and Google OAuth.\n` +
        `Re-run with --non-interactive to generate the secrets, take every default and leave OAuth blank.`,
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Generate the three secrets. Never ask.
  // ---------------------------------------------------------------------------
  // Only when there is nothing usable already: regenerating JWT_SECRET on a
  // --force re-run would invalidate every session and every refresh token the
  // developer is holding, for no reason they asked for.
  const seed = new Map<string, string>(current ?? []);
  const generated: string[] = [];

  for (const key of GENERATED_KEYS) {
    const held = seed.get(key);
    if (held !== undefined && held !== '') continue;
    seed.set(key, generateBase64Key());
    generated.push(key);
  }

  // An unattended run answers with the local defaults rather than being
  // refused for not having a person to confirm them. Never over an existing
  // value: what is already in the file is a decision somebody made.
  if (options.nonInteractive === true) {
    for (const [key, value] of unattendedLocalAnswers(specs)) {
      const held = seed.get(key);
      if (held === undefined || held === '') seed.set(key, value);
    }
  }

  // The flag is an explicit statement, so it wins over the file.
  if (options.adminEmail !== undefined && options.adminEmail !== '') {
    seed.set('INITIAL_ADMIN_EMAIL', options.adminEmail);
  }

  if (generated.length > 0) {
    write('');
    write(`  Generated ${generated.length} secret(s) with the CSPRNG: ${generated.join(', ')}`);
    write('  They are written to the file below and shown nowhere else.');
  }

  // ---------------------------------------------------------------------------
  // 3. The wizard - the deploy one, with the local profile.
  // ---------------------------------------------------------------------------
  const prepared = localSpecs(specs);
  const appUrl =
    seed.get('APP_URL') ?? prepared.find((spec) => spec.key === 'APP_URL')?.defaultValue ?? '';

  const { values } = await runEnvWizard({
    specs: prepared,
    // Only consulted by derivations that want a bare host name; the local
    // profile derives from APP_URL itself, so this is descriptive rather than
    // load-bearing here.
    domain: hostOf(appUrl),
    existing: seed,
    metadata: localMetadataFor,
    ...(options.all === undefined ? {} : { all: options.all }),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.promptContext === undefined ? {} : { ctx: options.promptContext }),
  });

  // ---------------------------------------------------------------------------
  // 4. Write it. 0600, because it holds every secret this application has.
  // ---------------------------------------------------------------------------
  mkdirSync(dirname(envPath), { recursive: true });
  // Serialised against the ORIGINAL specs, so the generated file keeps the
  // template's section banners and key order and diffs cleanly against it.
  writeFileSync(envPath, serializeEnvFile(values, specs), { mode: 0o600 });

  const missingRequired = REQUIRED_TO_RUN.filter((key) => {
    const value = values.get(key);
    return value === undefined || value === '';
  });

  write('');
  write(`  Wrote ${envPath} (${values.size} variables, mode 0600)`);

  for (const line of formatNextSteps(values, missingRequired)) write(line);

  return {
    envPath,
    variables: values.size,
    generated,
    missingRequired,
  };
}

/** Bare host of a URL, or the input unchanged when it is not one. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * What to do next, in the order it has to be done.
 *
 * Written from the values that were actually chosen rather than as a fixed
 * block of prose: the migration command depends on POSTGRES_HOST, because a
 * compose service name resolves inside the stack and nowhere else, and a
 * person told to run the wrong one of the two gets a connection error with no
 * hint that it was the instruction that was wrong.
 */
export function formatNextSteps(
  values: ReadonlyMap<string, string>,
  missingRequired: readonly string[],
): string[] {
  const lines: string[] = [];
  const inCompose = isComposeInternalHost(values.get('POSTGRES_HOST'));
  const appUrl = values.get('APP_URL') ?? '';
  const adminEmail = values.get('INITIAL_ADMIN_EMAIL') ?? '';

  const composeFiles = ['-f base.compose.yml', '-f dev.compose.yml'];
  if (inCompose) composeFiles.push('-f devdb.compose.yml');
  const compose = `docker compose ${composeFiles.join(' ')}`;
  const migrate = 'npm run prisma:migrate --workspace=api';
  const seed = 'npm run prisma:seed --workspace=api';

  if (missingRequired.length > 0) {
    lines.push('');
    lines.push('  ---------------------------------------------------------------');
    lines.push('  GOOGLE OAUTH IS REQUIRED. The API will not start yet.');
    lines.push('  ---------------------------------------------------------------');
    lines.push('');
    lines.push(`  These are empty: ${missingRequired.join(', ')}`);
    lines.push('');
    lines.push('  Without GOOGLE_CLIENT_ID the API exits during bootstrap with');
    lines.push('  "OAuth2Strategy requires a clientID option" - it is not a');
    lines.push('  degraded mode, the process does not come up. Without');
    lines.push('  INITIAL_ADMIN_EMAIL nobody can log in: the allowlist refuses');
    lines.push('  every address, and that one is what seeds the first Admin.');
    lines.push('');
    lines.push('  Create an OAuth client at');
    lines.push('    https://console.cloud.google.com/apis/credentials');
    lines.push('  with this as an authorised redirect URI:');
    lines.push(`    ${values.get('GOOGLE_CALLBACK_URL') ?? ''}`);
    lines.push('  then set the values in the file above.');
  }

  lines.push('');
  lines.push('  Next steps');
  lines.push('');
  lines.push('  1. Create the shared docker network (once per machine):');
  lines.push('       docker network create devnet');
  lines.push('');
  lines.push('  2. Start the stack, from infra/compose:');
  lines.push(`       ${compose} up`);
  if (inCompose) {
    lines.push('');
    lines.push(
      `     The devdb overlay is included because POSTGRES_HOST is "${values.get('POSTGRES_HOST') ?? ''}",`,
    );
    lines.push('     which is the database container it provides. Drop that -f if you');
    lines.push('     meant a PostgreSQL of your own, and change POSTGRES_HOST to match.');
  } else {
    lines.push('');
    lines.push('     No PostgreSQL of your own? Add the database overlay:');
    lines.push(`       ${compose} -f devdb.compose.yml up`);
    lines.push('     and set POSTGRES_HOST to the service name');
    lines.push(`     (${COMPOSE_DB_HOST}) so the api container can reach it.`);
  }
  lines.push('');
  lines.push('  3. Apply the database schema:');
  if (inCompose) {
    lines.push(`       docker compose ${composeFiles.join(' ')} exec api ${migrate}`);
    lines.push(`     (POSTGRES_HOST is a compose service name, so this runs inside`);
    lines.push('      the stack rather than from this checkout.)');
  } else {
    lines.push(`       ${migrate}`);
  }
  lines.push('');
  lines.push('  4. Seed the roles, permissions and the admin allowlist entry:');
  lines.push(inCompose ? `       docker compose ${composeFiles.join(' ')} exec api ${seed}` : `       ${seed}`);
  lines.push('');
  lines.push(`  5. Open ${appUrl} and sign in with Google as`);
  lines.push(
    adminEmail === ''
      ? '     whichever address you set as INITIAL_ADMIN_EMAIL.'
      : `     ${adminEmail} - the first login with that address becomes Admin.`,
  );
  lines.push('');

  return lines;
}
