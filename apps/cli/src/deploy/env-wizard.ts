import { UsageError } from '../errors.js';
import {
  confirm,
  prompt,
  promptSecret,
  type PromptContext,
} from '../prompt.js';
import {
  ALL_CHECKS,
  probeTcp as defaultProbeTcp,
  runChecks as defaultRunChecks,
  type Check,
  type CompletedCheck,
} from './checks/index.js';
import {
  generateBase64Key,
  metadataFor,
  type DeriveContext,
  type EnvGroup,
  type EnvVarMetadata,
  type Suggestion,
} from './env-metadata.js';
import type { EnvVarSpec } from './env-spec.js';
import type { SiblingPort } from './layout.js';
import { unknownServerFacts, type ServerFacts } from './server-facts.js';
import {
  DOMAIN_FIELD,
  INSTALL_WIZARD_STEPS,
  resolveSteps,
  validateDomain,
  type StepCheckBase,
  type StepCheckContext,
  type WizardStep,
  type WizardStepContext,
} from './wizard/steps.js';

// =============================================================================
// The install wizard  (issue #175, epic #168; v2 in issue #127, epic #118)
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
// SINCE #127 THE QUESTIONS ARE WALKED IN STEPS (wizard/steps.ts), and this
// file is one of the two renderers of that list - the readline one. Three
// things happen at a step boundary that did not happen before:
//
//   1. A SUGGESTION IS SHOWN WITH ITS REASON. A key with `suggest` metadata is
//      proposed from the server ("3536: 3535 is used by demo") and is the
//      default the operator can accept with Enter - never applied without
//      being seen, even unattended, where it is printed in the review table.
//   2. THE STEP'S CHECKS RUN BEFORE THE NEXT QUESTION. A wrong password is
//      found by `database-credentials` right after the database step, not by a
//      validation pass after fifteen more answers. A `fail` re-enters the
//      step with the remedy shown; a `warn` is shown and the wizard moves on.
//   3. A BLANK SECRET IS GENERATED, ON EVERY PATH. The interactive path always
//      offered "Generate one?"; the unattended path used to report the key as
//      unresolved, which is why the TUI's install (nonInteractive: true) could
//      not succeed. `generateMissing` - on by default without a terminal -
//      fixes that.
//
// WRITING THE FILE IS NOT THIS MODULE'S JOB. It returns a map; the install step
// serialises it at 0600. That keeps the wizard testable without a filesystem.
// =============================================================================

/** How a step's checks are run. Everything is injectable so no test hits the network. */
export interface WizardCheckOptions {
  /** The registry the steps' check ids are looked up in. Default: ALL_CHECKS. */
  checks?: readonly Check[] | undefined;
  runChecks?: typeof defaultRunChecks | undefined;
  probeTcp?: typeof defaultProbeTcp | undefined;
  /** Everything a check needs that is not an answer: the runner, the layout, the skip flags. */
  context: StepCheckBase;
}

export interface WizardOptions {
  specs: readonly EnvVarSpec[];
  /** Values already on disk. Used as prompt defaults and carried through. */
  existing?: ReadonlyMap<string, string> | undefined;
  /**
   * The public hostname; derived values are computed from it. Asked in the
   * `domain` step when absent - and, without a terminal, reported unresolved.
   */
  domain?: string | undefined;
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
   * THIS IS THE PROFILE SEAM (issue #344). `init` bootstraps a LOCAL
   * checkout, and local differs from a VPS in exactly the places this registry
   * encodes: NODE_ENV is not forced to production, APP_URL is not derived from
   * a public domain, and the observability defaults are wanted rather than
   * opted into. Passing a different RESOLVER expresses that in one argument
   * and leaves the deploy path byte-for-byte unchanged - which is the whole
   * reason it is a parameter here rather than a second copy of this wizard.
   */
  metadata?: ((key: string) => EnvVarMetadata) | undefined;
  ctx?: PromptContext | undefined;
  /** The step list to walk. Default: the install wizard's. */
  steps?: readonly WizardStep[] | undefined;
  /** What the server looks like (#127); every fact unknown when not given. */
  facts?: ServerFacts | undefined;
  /** Every other installed app's recorded port (#127). */
  siblingPorts?: readonly SiblingPort[] | undefined;
  /** Loopback bind probe for the port suggestion; injected by tests. */
  portFree?: ((port: number) => Promise<boolean>) | undefined;
  /**
   * Generate a blank key that has `generate` metadata instead of reporting
   * it unresolved. Defaults to `nonInteractive`: with a terminal the operator
   * is asked, without one there is nobody to ask and a fresh CSPRNG value is
   * the right answer for a secret nobody has chosen yet.
   */
  generateMissing?: boolean | undefined;
  /**
   * Run each step's `onLeave` checks with the answers so far. Absent, no
   * check runs - the local profile (`init`) has no server to verify against.
   */
  inlineChecks?: WizardCheckOptions | undefined;
}

/** Shown in the review step. Never holds a usable secret. */
export interface WizardSummaryRow {
  key: string;
  /** Masked when the key is a secret. */
  display: string;
  source:
    | 'asked'
    | 'generated'
    | 'derived'
    | 'fixed'
    | 'existing'
    | 'default'
    | 'suggested'
    | 'skipped';
  /** Why a suggested value was proposed; shown beside it in the review. */
  reason?: string | undefined;
}

export interface WizardResult {
  values: Map<string, string>;
  summary: WizardSummaryRow[];
  /** The domain, given or answered. */
  domain: string;
  /** Every inline check that ran, in order, for the caller's journal. */
  checks: CompletedCheck[];
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
 * when the server has a suggestion for it and nothing is set, or when --all
 * was passed. Everything else takes its default.
 */
function shouldAsk(
  metadata: EnvVarMetadata,
  current: string | undefined,
  all: boolean,
): boolean {
  if (all) return true;
  if (metadata.essential === true) return true;
  if (metadata.secret === true && isBlank(current)) return true;
  if (metadata.suggest !== undefined && isBlank(current)) return true;
  return false;
}

interface Output {
  write(chunk: string): unknown;
}

interface Answer {
  value: string;
  source: WizardSummaryRow['source'];
  reason?: string | undefined;
}

/** The per-run state the step loop and the per-key resolver share. */
interface Run {
  options: WizardOptions;
  resolveMetadata: (key: string) => EnvVarMetadata;
  all: boolean;
  nonInteractive: boolean;
  generateMissing: boolean;
  groups: readonly EnvGroup[];
  facts: ServerFacts;
  siblingPorts: readonly SiblingPort[];
  output: Output;
  values: Map<string, string>;
  domain: string | undefined;
}

export async function runEnvWizard(options: WizardOptions): Promise<WizardResult> {
  const {
    specs,
    all = false,
    nonInteractive = false,
    groups = [],
    metadata: resolveMetadata = metadataFor,
    ctx,
    steps = INSTALL_WIZARD_STEPS,
  } = options;

  const run: Run = {
    options,
    resolveMetadata,
    all,
    nonInteractive,
    generateMissing: options.generateMissing ?? nonInteractive,
    groups,
    facts: options.facts ?? unknownServerFacts(),
    siblingPorts: options.siblingPorts ?? [],
    output: ctx?.output ?? process.stderr,
    values: new Map<string, string>(options.existing ?? []),
    domain: options.domain,
  };

  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const summary: WizardSummaryRow[] = [];
  const unresolved: string[] = [];
  const checks: CompletedCheck[] = [];
  const failedChecks: CompletedCheck[] = [];

  for (const { step, fields } of resolveSteps(steps, specs, { resolve: resolveMetadata, groups })) {
    if (step.id === 'review' || fields.length === 0) continue;

    // A step is a loop: a failed check re-enters it with the typed values as
    // the new defaults, so only the wrong one has to be retyped.
    for (;;) {
      const rows: WizardSummaryRow[] = [];
      const stepUnresolved: string[] = [];

      if (!nonInteractive && fields.some((field) => willAsk(run, field, byKey))) {
        printIntro(run, step);
      }

      for (const field of fields) {
        if (field === DOMAIN_FIELD) {
          const domain = await resolveDomain(run, ctx);
          if (domain === undefined) stepUnresolved.push('domain (pass --domain)');
          else run.domain = domain;
          continue;
        }

        const spec = byKey.get(field);
        if (spec === undefined) continue;

        const outcome = await resolveKey(run, spec, ctx);
        if (outcome === 'unresolved') stepUnresolved.push(spec.key);
        else if (outcome !== undefined) rows.push(outcome);
      }

      const results =
        step.onLeave !== undefined && options.inlineChecks !== undefined && stepUnresolved.length === 0
          ? await step.onLeave(checkContext(run, options.inlineChecks))
          : [];
      checks.push(...results);
      if (!nonInteractive) printResults(run.output, results);

      const failed = results.filter((result) => result.status === 'fail');
      if (failed.length > 0 && !nonInteractive) {
        run.output.write(
          `\n  ${failed.length} check(s) failed in the ${step.title} step. The values above can be corrected now.\n`,
        );
        const again = await confirm('  Correct them now?', { defaultValue: true }, ctx);
        if (!again) {
          throw new UsageError(
            `Stopped at the ${step.title} step:\n${describeFailures(failed)}`,
          );
        }
        continue;
      }

      // Collected rather than thrown, so an unattended run reports EVERY
      // failing check at once, like the unresolved keys below.
      failedChecks.push(...failed);
      summary.push(...rows);
      unresolved.push(...stepUnresolved);
      break;
    }
  }

  if (unresolved.length > 0) {
    throw new UsageError(
      `Cannot run without a terminal: ${unresolved.length} value(s) are missing or invalid.\n` +
        unresolved.map((key) => `  - ${key}`).join('\n') +
        `\nSet them in the environment file or with --answer, or re-run without --non-interactive.`,
    );
  }

  if (failedChecks.length > 0) {
    throw new UsageError(
      `The environment did not pass its checks:\n${describeFailures(failedChecks)}\n` +
        `Fix the values and re-run, or re-run without --non-interactive to correct them in place.`,
    );
  }

  await review(summary, run.output, nonInteractive, ctx);

  return { values: run.values, summary, domain: run.domain ?? '', checks };
}

function describeFailures(failed: readonly CompletedCheck[]): string {
  return failed
    .map((result) => `  - ${result.id}: ${result.detail}\n    ${result.remedy ?? ''}`)
    .join('\n');
}

function stepContext(run: Run): WizardStepContext {
  return { domain: run.domain, answers: run.values, facts: run.facts };
}

function checkContext(run: Run, inline: WizardCheckOptions): StepCheckContext {
  return {
    ...stepContext(run),
    checks: inline.checks ?? ALL_CHECKS,
    runChecks: inline.runChecks ?? defaultRunChecks,
    probeTcp: inline.probeTcp ?? defaultProbeTcp,
    base: inline.context,
  };
}

function deriveContext(run: Run): DeriveContext {
  return {
    domain: run.domain ?? '',
    answers: run.values,
    facts: run.facts,
    siblingPorts: run.siblingPorts,
    ...(run.options.portFree === undefined ? {} : { portFree: run.options.portFree }),
  };
}

/** Whether a field will put a question to the operator, without asking it. */
function willAsk(run: Run, field: string, byKey: ReadonlyMap<string, EnvVarSpec>): boolean {
  if (field === DOMAIN_FIELD) return isBlank(run.domain);
  const spec = byKey.get(field);
  if (spec === undefined) return false;
  const metadata = run.resolveMetadata(spec.key);
  if (metadata.never === true || metadata.fixed !== undefined || metadata.derive !== undefined) {
    return false;
  }
  if (metadata.group !== undefined && !run.groups.includes(metadata.group)) return false;
  return shouldAsk(metadata, run.values.get(spec.key), run.all);
}

function printIntro(run: Run, step: WizardStep): void {
  run.output.write(`\n  ${step.title}\n  ${'-'.repeat(step.title.length)}\n`);
  for (const line of step.intro(stepContext(run))) {
    run.output.write(`  ${line}\n`);
  }
}

const MARKS: Record<CompletedCheck['status'], string> = {
  pass: 'OK',
  warn: '!!',
  fail: 'XX',
  skip: '--',
};

function printResults(output: Output, results: readonly CompletedCheck[]): void {
  if (results.length === 0) return;
  output.write('\n');
  for (const result of results) {
    output.write(`  ${MARKS[result.status]} ${result.title.padEnd(30)}${result.detail}\n`);
    if (result.remedy !== undefined && (result.status === 'fail' || result.status === 'warn')) {
      output.write(`       -> ${result.remedy}\n`);
    }
  }
}

async function resolveDomain(run: Run, ctx: PromptContext | undefined): Promise<string | undefined> {
  if (!isBlank(run.domain)) {
    if (!run.nonInteractive) run.output.write(`\n  Domain: ${run.domain}\n`);
    return run.domain;
  }
  if (run.nonInteractive) return undefined;

  for (;;) {
    const value = await prompt('  Domain: ', ctx);
    const message = validateDomain(value);
    if (message === undefined) return value;
    run.output.write(`  ! Domain ${message}\n`);
  }
}

/**
 * Resolves one key: never, fixed, derived, defaulted, generated, suggested or
 * asked. Returns the summary row, `undefined` when nothing is recorded (a
 * skipped group), or 'unresolved' when an unattended run has no usable value.
 */
async function resolveKey(
  run: Run,
  spec: EnvVarSpec,
  ctx: PromptContext | undefined,
): Promise<WizardSummaryRow | 'unresolved' | undefined> {
  const { values } = run;
  const metadata = run.resolveMetadata(spec.key);

  // Never written, whatever the template says. TEST_AUTH_ENABLED is the case
  // this exists for: true in production fails startup by design.
  if (metadata.never === true) {
    values.delete(spec.key);
    return undefined;
  }

  if (metadata.fixed !== undefined) {
    values.set(spec.key, metadata.fixed);
    return { key: spec.key, display: metadata.fixed, source: 'fixed' };
  }

  if (metadata.derive !== undefined) {
    const derived = metadata.derive(deriveContext(run));
    if (derived !== undefined) {
      values.set(spec.key, derived);
      return { key: spec.key, display: derived, source: 'derived' };
    }
  }

  // A group the operator did not ask for. An existing value is left alone -
  // turning observability off is not this wizard's decision to make.
  if (metadata.group !== undefined && !run.groups.includes(metadata.group)) {
    return undefined;
  }

  const current = values.get(spec.key);

  if (!shouldAsk(metadata, current, run.all)) {
    if (current === undefined && !spec.optional) {
      values.set(spec.key, spec.defaultValue);
      return { key: spec.key, display: displayValue(spec.defaultValue, metadata), source: 'default' };
    }
    if (current !== undefined) {
      return { key: spec.key, display: displayValue(current, metadata), source: 'existing' };
    }
    return undefined;
  }

  // Only when nothing usable is set: a value on disk, or one given with
  // --answer, is the operator's and is never second-guessed by the server.
  const suggestion =
    metadata.suggest !== undefined && isBlank(current)
      ? await metadata.suggest(deriveContext(run))
      : undefined;

  if (run.nonInteractive) {
    return resolveUnattended(run, spec, metadata, current, suggestion);
  }

  const answer = await ask(run, spec, metadata, current, suggestion, ctx);
  if (answer.source === 'skipped') {
    values.delete(spec.key);
    return { key: spec.key, display: '(skipped)', source: 'skipped' };
  }
  values.set(spec.key, answer.value);
  return {
    key: spec.key,
    display: displayValue(answer.value, metadata),
    source: answer.source,
    ...(answer.reason === undefined ? {} : { reason: answer.reason }),
  };
}

function resolveUnattended(
  run: Run,
  spec: EnvVarSpec,
  metadata: EnvVarMetadata,
  current: string | undefined,
  suggestion: Suggestion | undefined,
): WizardSummaryRow | 'unresolved' {
  const { values } = run;

  // Shown in the review table with its reason, which is what "never applied
  // silently" means where nobody is watching a prompt.
  if (suggestion !== undefined) {
    values.set(spec.key, suggestion.value);
    return {
      key: spec.key,
      display: displayValue(suggestion.value, metadata),
      source: 'suggested',
      reason: suggestion.reason,
    };
  }

  // An ESSENTIAL key must come from the environment file, never from the
  // template default. `POSTGRES_USER=postgres` and `POSTGRES_PASSWORD=
  // postgres` are what .env.example ships; accepting them because nobody
  // said otherwise would deploy those credentials silently, which is the
  // opposite of what a non-interactive run should do. `defaultAcceptable`
  // marks the exceptions whose default is a real answer (POSTGRES_SSL=false).
  const candidate =
    metadata.essential === true
      ? (current ?? (metadata.defaultAcceptable === true ? spec.defaultValue : undefined))
      : (current ?? (spec.optional ? undefined : spec.defaultValue));

  // `allowBlank` keys are the exception the local profile needs: an empty
  // GOOGLE_CLIENT_ID means "not set up yet", which is a state a freshly
  // cloned checkout is genuinely allowed to be in. Blank skips validation
  // (a validator's job is to judge a value, and there isn't one); anything
  // actually present is still judged below.
  if (isBlank(candidate) && metadata.allowBlank === true) {
    values.set(spec.key, '');
    return { key: spec.key, display: displayValue('', metadata), source: 'default' };
  }

  // A blank secret with `generate` metadata is generated, not reported: the
  // TUI and CI have nobody to ask, and a fresh CSPRNG value is exactly what
  // the interactive path would have offered.
  if (isBlank(candidate) && metadata.generate !== undefined && run.generateMissing) {
    values.set(spec.key, generateBase64Key());
    return { key: spec.key, display: MASK, source: 'generated' };
  }

  const invalid =
    isBlank(candidate) || metadata.validate?.(candidate as string) !== undefined;
  if (invalid) return 'unresolved';

  values.set(spec.key, candidate as string);
  return {
    key: spec.key,
    display: displayValue(candidate as string, metadata),
    source: current === undefined ? 'default' : 'existing',
  };
}

async function ask(
  run: Run,
  spec: EnvVarSpec,
  metadata: EnvVarMetadata,
  current: string | undefined,
  suggestion: Suggestion | undefined,
  ctx: PromptContext | undefined,
): Promise<Answer> {
  const { output } = run;

  // The template's own comment is the best help text available, and it is
  // already written for a human - reprinting it beats inventing a worse one.
  // Metadata help, when there is any, follows it.
  const help = [spec.help, metadata.help ?? ''].filter((text) => text !== '').join('\n');
  output.write('\n');
  for (const line of help === '' ? [] : help.split('\n')) {
    output.write(`  # ${line}\n`);
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

  if (suggestion !== undefined) {
    output.write(`  Suggested: ${suggestion.value} (${suggestion.reason})\n`);
  }

  for (;;) {
    // A commented-out template key has no default to keep: the value after
    // its `#` is an example, and Enter leaves the key out rather than
    // writing the example as if somebody had chosen it.
    const fallback = current ?? suggestion?.value ?? (spec.optional ? '' : spec.defaultValue);
    const suffix =
      metadata.secret === true
        ? isBlank(fallback)
          ? ''
          : ' [leave blank to keep the current value]'
        : isBlank(fallback)
          ? spec.optional && spec.defaultValue !== ''
            ? ` [blank to skip; for example ${spec.defaultValue}]`
            : ''
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

    // A commented-out template key with nothing typed is left out of the
    // file, not written empty: "skip" is the third answer an optional
    // variable has.
    if (value === '' && spec.optional) {
      return { value, source: 'skipped' };
    }

    const message = metadata.validate?.(value);
    if (message !== undefined) {
      // Re-asked on the same key, the way invoke.tsx keeps a user on the field
      // they got wrong rather than making them start the flow again.
      output.write(`  ! ${spec.key} ${message}\n`);
      continue;
    }

    if (raw === '' && current === undefined && suggestion !== undefined) {
      return { value, source: 'suggested', reason: suggestion.reason };
    }
    return { value, source: 'asked' };
  }
}

async function review(
  summary: readonly WizardSummaryRow[],
  output: Output,
  nonInteractive: boolean,
  ctx: PromptContext | undefined,
): Promise<void> {
  const width = summary.reduce((max, row) => Math.max(max, row.key.length), 0);

  output.write('\n  Environment\n\n');
  for (const row of summary) {
    // A suggestion always carries its reason into the table: this is the one
    // place an unattended run shows why 3536 rather than 3535.
    const source = row.reason === undefined ? row.source : `${row.source}: ${row.reason}`;
    output.write(`  ${row.key.padEnd(width)}  ${row.display}  (${source})\n`);
  }
  output.write('\n');

  if (nonInteractive) return;

  const accepted = await confirm('  Write this environment?', { defaultValue: true }, ctx);
  if (!accepted) {
    throw new UsageError('Cancelled before anything was written.');
  }
}
