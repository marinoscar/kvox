import { UsageError } from '../errors.js';
import {
  confirm,
  prompt,
  promptSecret,
  type PromptContext,
} from '../prompt.js';
import {
  generateBase64Key,
  metadataFor,
  type EnvGroup,
  type EnvVarMetadata,
} from './env-metadata.js';
import type { EnvVarSpec } from './env-spec.js';

// =============================================================================
// The install wizard  (issue #175, epic #168)
// =============================================================================
//
// Turns the spec parsed from .env.example into the values a deployment needs.
//
// IT ASKS FOR THE ESSENTIAL SUBSET, NOT ALL THIRTY-FOUR VARIABLES. Roughly a
// dozen questions; everything else takes its template default silently, with
// --all to review the rest. Burying the twelve that matter among thirty-four is
// how a wizard becomes something people click through, and every extra question
// is another chance to fat-finger a working default.
//
// This is the repository's own precedent, not a new opinion:
// tui/screens/invoke.tsx deliberately offers `@file.json` rather than making
// somebody type a long value into a single-line field, on the stated grounds
// that a long value is miserable to type. Thirty-four fields over SSH is the
// same problem.
//
// WRITING THE FILE IS NOT THIS MODULE'S JOB. It returns a map; the install step
// serialises it at 0600. That keeps the wizard testable without a filesystem.
// =============================================================================

export interface WizardOptions {
  specs: readonly EnvVarSpec[];
  /** Values already on disk. Used as prompt defaults and carried through. */
  existing?: ReadonlyMap<string, string> | undefined;
  /** The public hostname; derived values are computed from it. */
  domain: string;
  /** Review every variable, not only the essential ones. */
  all?: boolean | undefined;
  /** Never prompt. Fail listing everything unresolved. */
  nonInteractive?: boolean | undefined;
  /** Optional feature groups the operator opted into. */
  groups?: readonly EnvGroup[] | undefined;
  /**
   * Resolves the annotation for a key. Defaults to `metadataFor` - the VPS
   * deployment's ENV_METADATA, which is what every existing caller wants.
   *
   * THIS IS THE PROFILE SEAM (issue #344). `appctl init` bootstraps a LOCAL
   * checkout, and local differs from a VPS in exactly the places this registry
   * encodes: NODE_ENV is not forced to production, APP_URL is not derived from
   * a public domain, and the observability defaults are wanted rather than
   * opted into. Passing a different RESOLVER expresses that in one argument
   * and leaves the deploy path byte-for-byte unchanged - which is the whole
   * reason it is a parameter here rather than a second copy of this wizard.
   */
  metadata?: ((key: string) => EnvVarMetadata) | undefined;
  ctx?: PromptContext | undefined;
}

/** Shown in the review step. Never holds a usable secret. */
export interface WizardSummaryRow {
  key: string;
  /** Masked when the key is a secret. */
  display: string;
  source: 'asked' | 'generated' | 'derived' | 'fixed' | 'existing' | 'default';
}

const MASK = '********';

/** Masked to a constant, not a prefix: unlike a token id, none of a secret's
 *  characters are useful to see, and a partial reveal only helps an observer. */
function displayValue(value: string, metadata: EnvVarMetadata): string {
  if (value === '') return '(empty)';
  return metadata.secret === true ? MASK : value;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value === '';
}

/**
 * Decides whether a key is put to the operator.
 *
 * Asked when it is essential, when it is a secret with nothing usable already,
 * or when --all was passed. Everything else takes its default.
 */
function shouldAsk(
  metadata: EnvVarMetadata,
  current: string | undefined,
  all: boolean,
): boolean {
  if (all) return true;
  if (metadata.essential === true) return true;
  if (metadata.secret === true && isBlank(current)) return true;
  return false;
}

export interface WizardResult {
  values: Map<string, string>;
  summary: WizardSummaryRow[];
}

export async function runEnvWizard(options: WizardOptions): Promise<WizardResult> {
  const {
    specs,
    domain,
    all = false,
    nonInteractive = false,
    groups = [],
    metadata: resolveMetadata = metadataFor,
    ctx,
  } = options;

  const output = ctx?.output ?? process.stderr;
  const values = new Map<string, string>(options.existing ?? []);
  const summary: WizardSummaryRow[] = [];
  const unresolved: string[] = [];

  for (const spec of specs) {
    const metadata = resolveMetadata(spec.key);

    // Never written, whatever the template says. TEST_AUTH_ENABLED is the case
    // this exists for: true in production fails startup by design.
    if (metadata.never === true) {
      values.delete(spec.key);
      continue;
    }

    if (metadata.fixed !== undefined) {
      values.set(spec.key, metadata.fixed);
      summary.push({ key: spec.key, display: metadata.fixed, source: 'fixed' });
      continue;
    }

    if (metadata.derive !== undefined) {
      const derived = metadata.derive({ domain, answers: values });
      if (derived !== undefined) {
        values.set(spec.key, derived);
        summary.push({ key: spec.key, display: derived, source: 'derived' });
        continue;
      }
    }

    // A group the operator did not ask for. An existing value is left alone -
    // turning observability off is not this wizard's decision to make.
    if (metadata.group !== undefined && !groups.includes(metadata.group)) {
      continue;
    }

    const current = values.get(spec.key);

    if (!shouldAsk(metadata, current, all)) {
      if (current === undefined && !spec.optional) {
        values.set(spec.key, spec.defaultValue);
        summary.push({
          key: spec.key,
          display: displayValue(spec.defaultValue, metadata),
          source: 'default',
        });
      } else if (current !== undefined) {
        summary.push({
          key: spec.key,
          display: displayValue(current, metadata),
          source: 'existing',
        });
      }
      continue;
    }

    if (nonInteractive) {
      // An ESSENTIAL key must come from the environment file, never from the
      // template default. `POSTGRES_USER=postgres` and `POSTGRES_PASSWORD=
      // postgres` are what .env.example ships; accepting them because nobody
      // said otherwise would deploy those credentials silently, which is the
      // opposite of what a non-interactive run should do.
      const candidate =
        metadata.essential === true
          ? current
          : (current ?? (spec.optional ? undefined : spec.defaultValue));
      // `allowBlank` keys are the exception the local profile needs: an empty
      // GOOGLE_CLIENT_ID means "not set up yet", which is a state a freshly
      // cloned checkout is genuinely allowed to be in. Blank skips validation
      // (a validator's job is to judge a value, and there isn't one); anything
      // actually present is still judged below.
      if (isBlank(candidate) && metadata.allowBlank === true) {
        values.set(spec.key, '');
        summary.push({ key: spec.key, display: displayValue('', metadata), source: 'default' });
        continue;
      }

      const invalid =
        isBlank(candidate) || metadata.validate?.(candidate as string) !== undefined;

      if (invalid) {
        // Collected rather than thrown, so one run reports EVERY missing key.
        // A CI operator learning about them one at a time is a bad afternoon.
        unresolved.push(spec.key);
        continue;
      }

      values.set(spec.key, candidate as string);
      summary.push({
        key: spec.key,
        display: displayValue(candidate as string, metadata),
        source: current === undefined ? 'default' : 'existing',
      });
      continue;
    }

    const answer = await ask(spec, metadata, current, ctx, output);
    values.set(spec.key, answer.value);
    summary.push({
      key: spec.key,
      display: displayValue(answer.value, metadata),
      source: answer.source,
    });
  }

  if (unresolved.length > 0) {
    throw new UsageError(
      `Cannot run without a terminal: ${unresolved.length} value(s) are missing or invalid.\n` +
        unresolved.map((key) => `  - ${key}`).join('\n') +
        `\nSet them in the environment file, or re-run without --non-interactive.`,
    );
  }

  await review(summary, output, nonInteractive, ctx);

  return { values, summary };
}

interface Answer {
  value: string;
  source: 'asked' | 'generated';
}

async function ask(
  spec: EnvVarSpec,
  metadata: EnvVarMetadata,
  current: string | undefined,
  ctx: PromptContext | undefined,
  output: { write(chunk: string): unknown },
): Promise<Answer> {
  // The template's own comment is the best help text available, and it is
  // already written for a human - reprinting it beats inventing a worse one.
  if (spec.help !== '') {
    output.write('\n');
    for (const line of spec.help.split('\n')) {
      output.write(`  # ${line}\n`);
    }
  } else {
    output.write('\n');
  }

  if (metadata.generate !== undefined && isBlank(current)) {
    const generate = await confirm(
      `  ${spec.key} is unset. Generate one?`,
      { defaultValue: true },
      ctx,
    );
    if (generate) {
      // Generating must not require typing anything: a value nobody has to
      // invent is a value nobody reuses from another system.
      return { value: generateBase64Key(), source: 'generated' };
    }
  }

  for (;;) {
    const fallback = current ?? spec.defaultValue;
    const suffix =
      metadata.secret === true
        ? isBlank(fallback)
          ? ''
          : ' [leave blank to keep the current value]'
        : isBlank(fallback)
          ? ''
          : ` [${fallback}]`;

    const raw =
      metadata.secret === true
        ? await promptSecret(`  ${spec.key}${suffix}: `, ctx)
        : await prompt(`  ${spec.key}${suffix}: `, ctx);

    const value = raw === '' ? fallback : raw;

    // Same rule as the unattended path: blank is an answer for these keys, and
    // re-asking would trap somebody who has not created their OAuth client yet
    // on a question they cannot answer and cannot skip.
    if (value === '' && metadata.allowBlank === true) {
      return { value, source: 'asked' };
    }

    const message = metadata.validate?.(value);
    if (message !== undefined) {
      // Re-asked on the same key, the way invoke.tsx keeps a user on the field
      // they got wrong rather than making them start the flow again.
      output.write(`  ! ${spec.key} ${message}\n`);
      continue;
    }

    return { value, source: 'asked' };
  }
}

async function review(
  summary: readonly WizardSummaryRow[],
  output: { write(chunk: string): unknown },
  nonInteractive: boolean,
  ctx: PromptContext | undefined,
): Promise<void> {
  const width = summary.reduce((max, row) => Math.max(max, row.key.length), 0);

  output.write('\n  Environment\n\n');
  for (const row of summary) {
    output.write(`  ${row.key.padEnd(width)}  ${row.display}  (${row.source})\n`);
  }
  output.write('\n');

  if (nonInteractive) return;

  const accepted = await confirm('  Write this environment?', { defaultValue: true }, ctx);
  if (!accepted) {
    throw new UsageError('Cancelled before anything was written.');
  }
}
