import {
  ALL_CHECKS,
  DEVNET_CHECK_ID,
  requiredChecks,
  type Check,
  type CompletedCheck,
} from '../../../deploy/checks/index.js';
import {
  generateBase64Key,
  metadataFor,
  validateBoolean,
  type EnvGroup,
  type EnvVarMetadata,
  type Suggestion,
} from '../../../deploy/env-metadata.js';
import type { EnvVarSpec } from '../../../deploy/env-spec.js';
import type { ServerFacts } from '../../../deploy/server-facts.js';
import {
  DOMAIN_FIELD,
  INSTALL_WIZARD_STEPS,
  STORAGE_CHECK_ID,
  googleRedirectUri,
  resolveSteps,
  validateDomain,
  type WizardStep as DataStep,
  type WizardStepContext,
} from '../../../deploy/wizard/steps.js';
import {
  CONFIRM_DEFAULT_INDEX,
  DEFAULT_CANCEL_LABEL,
  type ChecklistItem,
  type FormFieldSpec,
  type KeyValueRow,
  type SelectChoice,
  type WizardStep,
} from '../../components/index.js';

// =============================================================================
// The install wizard, as data  (issue #131, epic #118)
// =============================================================================
//
// EVERY QUESTION ON SCREEN COMES FROM deploy/wizard/steps.ts. This module
// binds that list to the ink vocabulary of tui/components — it turns a step's
// FIELD REFS into `FormFieldSpec`s, a step's completed checks into
// `ChecklistItem`s, and the collected answers into `KeyValueRow`s — and it
// declares NOTHING the readline renderer does not also ask. That is decision
// 10 of epic #118 and the reason #127 exists: a TUI-only question would drift
// from `--non-interactive` the first time somebody added a field to one and
// not the other.
//
// It is pure, with no React and no ink imports, for the reason every
// `tui/screens/*.test.ts` in this package states in its own header:
// `ink-testing-library` is not a dependency, so a screen is tested through
// the DATA it derives. Everything interesting about this wizard — which steps
// exist, which field a failed check sends the operator back to, whether a
// review row can leak a secret, which choice an abort dialog opens on — is
// therefore a function here rather than a branch inside a component.
//
// THE FOUR EXTRA FIELDS. `__domain` is steps.ts's own pseudo-key; this module
// adds `__name`, `__repo`, `__ref`, `__all` (Welcome), `__publicIp` (Domain),
// `__staging` and `__installCron` (Resources), plus one `__mode:<KEY>` per
// generated secret. They are flags and layout choices, not environment
// variables — `envAnswers` drops every `__`-prefixed key on the way to
// `runInstall`, which is what keeps them out of the written .env.
// =============================================================================

/** The step the wizard opens on. Not a `steps.ts` step: it asks no env key. */
export const WELCOME_STEP_ID = 'welcome';
export const REVIEW_STEP_ID = 'review';
/** The step every key no earlier step claimed lands in (`steps.ts`). */
export const CATCH_ALL_STEP_ID = 'optional';

/**
 * Keys on one page of the catch-all step (#240).
 *
 * `Form` renders EVERY field it is given, and a catch-all key costs two rows
 * (its keep/edit/skip list, then its value). Handing it the whole remainder
 * produced a seventy-four row frame: the focused field scrolled out of view,
 * so the cursor was invisible and every keystroke looked like it did nothing.
 * The step was not slow or awkward, it was impossible to finish.
 *
 * Six keys is twelve rows, which leaves the intro, the rail, the hints and a
 * check line inside a conventional 24-row terminal with room to spare. It is
 * a ceiling rather than a target: a section with two keys stays one page.
 */
export const CATCH_ALL_PAGE_SIZE = 6;

/** True for the catch-all step and every page generated from it. */
export function isCatchAllStep(id: string): boolean {
  return id === CATCH_ALL_STEP_ID || id.startsWith(`${CATCH_ALL_STEP_ID}:`);
}

/** Answers that are wizard state rather than environment variables. */
export const INTERNAL_PREFIX = '__';
export const NAME_FIELD = '__name';
export const REPO_FIELD = '__repo';
export const REF_FIELD = '__ref';
export const ALL_FIELD = '__all';
/** Which optional variable GROUPS the operator opted into, comma-separated. */
export const GROUPS_FIELD = '__groups';
export const PUBLIC_IP_FIELD = '__publicIp';
export const STAGING_FIELD = '__staging';
export const INSTALL_CRON_FIELD = '__installCron';
/** `__mode:JWT_SECRET` — generate the value, or paste one. */
export const SECRET_MODE_PREFIX = '__mode:';
/** `__opt:SENTRY_DSN` — keep the template's value, edit it, or leave it out. */
export const OPTION_MODE_PREFIX = '__opt:';

export function secretModeField(key: string): string {
  return `${SECRET_MODE_PREFIX}${key}`;
}

export function optionModeField(key: string): string {
  return `${OPTION_MODE_PREFIX}${key}`;
}

export type SecretMode = 'generate' | 'paste';

/**
 * The three answers an already-defaulted variable has.
 *
 * `keep` is not the same as `skip`: keeping writes the template's value,
 * skipping leaves the key out of the file altogether — which for a
 * commented-out key in `.env.example` is what the template itself says.
 */
export type OptionMode = 'keep' | 'edit' | 'skip';

export const OPTION_MODE_CHOICES: ReadonlyArray<SelectChoice<OptionMode>> = [
  { value: 'keep', label: 'Keep', hint: "The template's own value, unchanged." },
  { value: 'edit', label: 'Edit', hint: 'Type a value in the field below.' },
  { value: 'skip', label: 'Skip', hint: 'Leave the key out of the environment file.' },
];

/**
 * The same three answers, worded for what this key actually offers (#240).
 *
 * A key the template ships commented out, or with an empty value, has
 * nothing to keep - and "Keep" over a blank value row asks the operator to
 * keep something they cannot see. The first choice still WRITES nothing and
 * is still `keep`; only the words change, to say that the application's own
 * default applies. The mode is the contract, the label is the explanation,
 * and conflating the two is what made this read as a broken field.
 */
export function optionModeChoicesFor(
  spec: EnvVarSpec | undefined,
): ReadonlyArray<SelectChoice<OptionMode>> {
  const hasValue = (spec?.defaultValue ?? '') !== '' && spec?.optional !== true;
  if (hasValue) return OPTION_MODE_CHOICES;
  return [
    {
      value: 'keep',
      label: 'Leave unset',
      hint: "The template ships no value; the application's own default applies.",
    },
    { value: 'edit', label: 'Set a value', hint: 'Type a value in the field below.' },
    { value: 'skip', label: 'Skip', hint: 'Leave the key out of the environment file.' },
  ];
}

export const SECRET_MODE_CHOICES: ReadonlyArray<SelectChoice<SecretMode>> = [
  {
    value: 'generate',
    label: 'Generate one',
    hint: '32 bytes from the CSPRNG. Nothing to invent, nothing reused from another system.',
  },
  { value: 'paste', label: 'Paste my own', hint: 'Type or paste a value below; it stays masked.' },
];

const YES_NO: ReadonlyArray<SelectChoice> = [
  { value: 'false', label: 'No' },
  { value: 'true', label: 'Yes' },
];

/** The answers, keyed by field ref. One object, kept across Back and Next. */
export type InstallAnswers = Readonly<Record<string, string>>;

/**
 * Records one answer.
 *
 * The ONLY function in this module that changes an answer, and there is
 * deliberately no counterpart that clears them: `wizardReduce` moves an index
 * and returns a `WizardTransition` that has no room for answers in it, so
 * "Back preserves what was typed" is a property of the types rather than a
 * behaviour somebody has to remember not to break.
 */
export function withAnswer(
  answers: InstallAnswers,
  key: string,
  value: string,
): InstallAnswers {
  if (answers[key] === value) return answers;
  return { ...answers, [key]: value };
}

/** The environment variables, with every wizard-internal field dropped. */
export function envAnswers(answers: InstallAnswers): Map<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(answers)) {
    if (key.startsWith(INTERNAL_PREFIX)) continue;
    // A blank answer SKIPS the key rather than writing it empty — the third
    // answer an optional variable has (env-wizard.ts's `skipped` source).
    if (value === '') continue;
    values.set(key, value);
  }
  return values;
}

export function answerOf(answers: InstallAnswers, key: string): string {
  return answers[key] ?? '';
}

export function isTrue(answers: InstallAnswers, key: string): boolean {
  return answers[key] === 'true';
}

/** The optional variable groups the operator opted into on Welcome. */
export function groupsOf(answers: InstallAnswers): EnvGroup[] {
  const raw = answerOf(answers, GROUPS_FIELD);
  return raw === '' ? [] : (raw.split(',').filter((part) => part !== '') as EnvGroup[]);
}

// -----------------------------------------------------------------------------
// The step list
// -----------------------------------------------------------------------------

export interface InstallStep extends WizardStep {
  /** The field refs this step puts on screen, in order. */
  fields: readonly string[];
  /**
   * Set on a generated catch-all page (#240): which template section it
   * covers, and where it sits among the pages. Drawn above the fields, and
   * the reason a wall of variables reads as progress rather than as a wall.
   */
  page?: { section: string; index: number; total: number } | undefined;
  /** The `steps.ts` step this renders, when it renders one. */
  data?: DataStep | undefined;
  /** Every field may be left blank. */
  optional?: boolean | undefined;
}

/** Fields this renderer adds to a `steps.ts` step, after its own. */
const EXTRA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  domain: [PUBLIC_IP_FIELD],
  resources: [STAGING_FIELD, INSTALL_CRON_FIELD],
};

const WELCOME_FIELDS: readonly string[] = [
  NAME_FIELD,
  REPO_FIELD,
  REF_FIELD,
  GROUPS_FIELD,
  ALL_FIELD,
];

export interface InstallStepOptions {
  /** Optional variable groups the operator opted into. */
  groups?: readonly EnvGroup[] | undefined;
  /** "Review every variable": keeps the `optional` catch-all step. */
  all?: boolean | undefined;
}

/**
 * Whether a key becomes a question, or is resolved without asking.
 *
 * The same four exclusions `essentialFields` applies, minus its `essential`
 * filter: this wizard walks every step, so a non-essential key in the
 * `storage` or `optional` step is asked when that step is shown.
 */
function isAsked(metadata: EnvVarMetadata): boolean {
  return (
    metadata.never !== true && metadata.fixed === undefined && metadata.derive === undefined
  );
}

/**
 * The steps the TUI walks: Welcome, then `INSTALL_WIZARD_STEPS` in its own
 * order, ending on Review.
 *
 * A step whose fields all resolved without asking is dropped rather than
 * shown empty — which is how `storage` disappears when the operator did not
 * opt into it, with no second condition here saying so. `review` is kept
 * although it asks nothing: it is where the summary and the confirmation go.
 */
export function installSteps(
  specs: readonly EnvVarSpec[],
  options: InstallStepOptions = {},
): InstallStep[] {
  const steps: InstallStep[] = [
    { id: WELCOME_STEP_ID, title: 'Welcome', fields: WELCOME_FIELDS },
  ];

  const byKey = new Map(specs.map((spec) => [spec.key, spec]));

  for (const { step, fields } of resolveSteps(INSTALL_WIZARD_STEPS, specs, {
    ...(options.groups === undefined ? {} : { groups: options.groups }),
  })) {
    if (step.id === CATCH_ALL_STEP_ID && options.all !== true) continue;

    const asked = fields.filter(
      (ref) => ref === DOMAIN_FIELD || (byKey.has(ref) && isAsked(metadataFor(ref))),
    );
    const all = [...asked, ...(EXTRA_FIELDS[step.id] ?? [])];
    if (step.id !== REVIEW_STEP_ID && all.length === 0) continue;

    if (isCatchAllStep(step.id)) {
      steps.push(...catchAllPages(step, all, specs));
      continue;
    }

    steps.push({
      id: step.id,
      title: step.title,
      fields: all,
      data: step,
      ...(step.optional === undefined ? {} : { optional: step.optional }),
    });
  }

  return steps;
}

/**
 * The catch-all, split into pages the terminal can actually draw.
 *
 * Split on the TEMPLATE'S OWN SECTION BANNERS rather than on a running count.
 * `parseEnvExample` already records the banner each key appeared under, so
 * the pages come out as `Web Push`, `Device Authorization Flow`,
 * `Observability` — groups an operator recognises, in the order the file
 * they were copied from lists them. Chunking by six alone would have been
 * fewer lines of code and would have split Observability down the middle.
 *
 * The cap still applies WITHIN a section, because a fork is free to put
 * thirty keys under one banner and that must not bring back the frame this
 * function exists to prevent.
 */
function catchAllPages(
  step: DataStep,
  fields: readonly string[],
  specs: readonly EnvVarSpec[],
): InstallStep[] {
  if (fields.length === 0) return [];

  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const chunks: Array<{ section: string; fields: string[] }> = [];

  for (const ref of fields) {
    const section = byKey.get(ref)?.section ?? '';
    const open = chunks[chunks.length - 1];
    if (open !== undefined && open.section === section && open.fields.length < CATCH_ALL_PAGE_SIZE) {
      open.fields.push(ref);
      continue;
    }
    chunks.push({ section, fields: [ref] });
  }

  return chunks.map((chunk, index) => ({
    // A distinct id per page: `useWizard` and `Form` both key on it, and two
    // pages sharing one id would make the second reuse the first's field
    // cursor. `isCatchAllStep` is what keeps every catch-all behaviour
    // attached to them.
    id: `${CATCH_ALL_STEP_ID}:${String(index)}`,
    // Deliberately identical across pages: `railSteps` collapses equal
    // adjacent titles into ONE rail entry, so seven pages do not turn a
    // ten-entry rail into a sixteen-entry one that wraps.
    title: step.title,
    fields: chunk.fields,
    data: step,
    page: { section: chunk.section, index: index + 1, total: chunks.length },
    ...(step.optional === undefined ? {} : { optional: step.optional }),
  }));
}

/**
 * The steps the CURSOR walks - one entry per real step, never collapsed.
 *
 * ⚠ `useWizard` MUST be built from this and never from `railSteps` (#243).
 * It clamps its index to the array's length and `wizardReduce` decides
 * `move` vs `finish` from the same array, so handing it the collapsed rail
 * caps the cursor at the number of RAIL ENTRIES. With thirteen catch-all
 * pages that stopped the wizard dead on page two with no error and no way
 * forward: `next()` reduced to `finish`, and `onFinish` is a deliberate
 * no-op because Review's own dialog starts the run.
 *
 * Before #240 `railSteps` was this function, so the two were interchangeable
 * by coincidence. They are not any more, which is why they have different
 * names and this note.
 */
export function cursorSteps(steps: readonly InstallStep[]): WizardStep[] {
  return steps.map((step) => ({ id: step.id, title: step.title }));
}

/**
 * The `WizardStep` pairs `WizardFrame` DRAWS ITS RAIL from - display only.
 *
 * Adjacent steps with the SAME TITLE collapse into one entry (#240). The
 * catch-all is several steps so the terminal can draw it, but it is one
 * thing to an operator, and a rail that counted its pages would report
 * sixteen steps for a wizard that asks ten questions.
 */
export function railSteps(steps: readonly InstallStep[]): WizardStep[] {
  const rail: WizardStep[] = [];
  for (const step of steps) {
    if (rail[rail.length - 1]?.title === step.title) continue;
    rail.push({ id: step.id, title: step.title });
  }
  return rail;
}

/** Which rail entry `index` (a step index) is drawn under. */
export function railIndexFor(steps: readonly InstallStep[], index: number): number {
  let rail = -1;
  let previous: string | undefined;
  for (let position = 0; position < steps.length; position += 1) {
    const title = steps[position]?.title;
    if (title !== previous) {
      rail += 1;
      previous = title;
    }
    if (position === index) return Math.max(0, rail);
  }
  return Math.max(0, rail);
}

// -----------------------------------------------------------------------------
// One step's fields, as a `Form`
// -----------------------------------------------------------------------------

export interface FormInput {
  specs: readonly EnvVarSpec[];
  answers: InstallAnswers;
  /** Server-derived defaults (#127), keyed by env key. */
  suggestions?: Readonly<Record<string, Suggestion>> | undefined;
}

const INTERNAL_FIELDS: Readonly<Record<string, FormFieldSpec>> = {
  [NAME_FIELD]: {
    kind: 'text',
    key: NAME_FIELD,
    label: 'App name',
    help: 'The folder under the apps root, and the docker compose project name.',
  },
  [REPO_FIELD]: {
    kind: 'text',
    key: REPO_FIELD,
    label: 'Repository',
    help: 'Detected from this checkout. Edit to deploy a different remote.',
  },
  [REF_FIELD]: {
    kind: 'text',
    key: REF_FIELD,
    label: 'Ref',
    help: 'Branch, tag or commit to deploy.',
  },
  [ALL_FIELD]: {
    kind: 'select',
    key: ALL_FIELD,
    label: 'Variables',
    help: 'How much of the environment file to walk through.',
    choices: [
      { value: 'false', label: 'Essential only', hint: 'Everything else takes its template default.' },
      {
        value: 'true',
        label: 'Review every variable',
        hint: 'Adds a step for every remaining key in .env.example.',
      },
    ],
  },
  [GROUPS_FIELD]: {
    kind: 'select',
    key: GROUPS_FIELD,
    label: 'Object storage',
    help: 'Uploads need S3-compatible storage. It can be configured later by editing the environment file.',
    choices: [
      { value: '', label: 'Not now', hint: 'The storage step is skipped.' },
      {
        value: 'storage',
        label: 'Configure it now',
        hint: 'Adds a step for the bucket, region, endpoint and keys.',
      },
    ],
  },
  [PUBLIC_IP_FIELD]: {
    kind: 'text',
    key: PUBLIC_IP_FIELD,
    label: 'Public IP',
    help: 'Only when this server is behind NAT: the address the DNS record should point at. Blank to use the detected interfaces.',
  },
  [STAGING_FIELD]: {
    kind: 'select',
    key: STAGING_FIELD,
    label: 'TLS',
    help: "Which Let's Encrypt endpoint issues the certificate.",
    choices: [
      {
        value: 'false',
        label: 'Production certificate',
        hint: 'Trusted by browsers. Five failures per hostname per hour, so a typo costs an afternoon.',
      },
      {
        value: 'true',
        label: 'Staging certificate (--staging)',
        hint: 'Untrusted by browsers, but effectively unlimited while working the setup out.',
      },
    ],
  },
  [INSTALL_CRON_FIELD]: {
    kind: 'select',
    key: INSTALL_CRON_FIELD,
    label: 'Renewal cron',
    help: 'A fresh certificate with nobody to renew it is a 90-day timer on an outage.',
    choices: [
      { value: 'true', label: 'Install the renewal cron' },
      { value: 'false', label: 'Leave renewal to me' },
    ],
  },
};

/** Defaults for the fields this renderer adds. */
export const INTERNAL_DEFAULTS: InstallAnswers = {
  [ALL_FIELD]: 'false',
  [GROUPS_FIELD]: '',
  [STAGING_FIELD]: 'false',
  [INSTALL_CRON_FIELD]: 'true',
};

/**
 * `step`'s fields as a `Form` can render them.
 *
 * Nothing here decides WHICH keys are asked — `installSteps` did that from
 * `steps.ts`. This decides only how each one is drawn: masked or not,
 * validated by whose rule, pre-filled with what, and as a text box or a list.
 */
export function formFieldsFor(step: InstallStep, input: FormInput): FormFieldSpec[] {
  const byKey = new Map(input.specs.map((spec) => [spec.key, spec]));
  const suggestions = input.suggestions ?? {};
  const fields: FormFieldSpec[] = [];

  for (const ref of step.fields) {
    if (ref === DOMAIN_FIELD) {
      fields.push({
        kind: 'text',
        key: DOMAIN_FIELD,
        label: 'Domain',
        help: 'The public hostname this deployment is served on.',
        placeholder: 'app.example.com',
        validate: validateDomain,
      });
      continue;
    }

    const internal = INTERNAL_FIELDS[ref];
    if (internal !== undefined) {
      fields.push(internal);
      continue;
    }

    const spec = byKey.get(ref);
    if (spec === undefined) continue;
    const metadata = metadataFor(ref);
    const suggestion = suggestions[ref];

    // A true/false key is a list, not a text box: `POSTGRES_SSL=flase` is a
    // typo the validator can only report after the fact.
    if (metadata.validate === validateBoolean) {
      fields.push({
        kind: 'select',
        key: ref,
        label: ref,
        choices: YES_NO,
        ...(helpFor(spec, metadata) === '' ? {} : { help: helpFor(spec, metadata) }),
      });
      continue;
    }

    // A generated secret is two controls: the choice, then the value it put
    // there — shown masked, so its length is all that is ever on screen.
    if (metadata.generate !== undefined) {
      fields.push({
        kind: 'select',
        key: secretModeField(ref),
        label: ref,
        choices: SECRET_MODE_CHOICES,
        ...(helpFor(spec, metadata) === '' ? {} : { help: helpFor(spec, metadata) }),
      });
      fields.push({
        kind: 'text',
        key: ref,
        label: `  value`,
        secret: true,
        help: 'Generated. Type here to replace it with your own.',
        validate: optionalise(metadata.validate, step.optional === true),
      });
      continue;
    }

    // The catch-all step reviews variables that ALREADY have an answer in the
    // template. "Keep it" is the common case there and must not require
    // retyping the value, so the three outcomes are a list rather than a
    // convention about what a blank line means.
    if (isCatchAllStep(step.id)) {
      fields.push({
        kind: 'select',
        key: optionModeField(ref),
        label: ref,
        choices: optionModeChoicesFor(spec),
        ...(helpFor(spec, metadata) === '' ? {} : { help: helpFor(spec, metadata) }),
      });
      fields.push({
        kind: 'text',
        key: ref,
        label: `  value`,
        ...(metadata.secret === true ? { secret: true } : {}),
        placeholder: placeholderFor(spec, metadata, suggestion),
        validate: optionalise(metadata.validate, true),
      });
      continue;
    }

    fields.push({
      kind: 'text',
      key: ref,
      label: ref,
      ...(helpFor(spec, metadata) === '' ? {} : { help: helpFor(spec, metadata) }),
      ...(metadata.secret === true ? { secret: true } : {}),
      placeholder: placeholderFor(spec, metadata, suggestion),
      ...(suggestion === undefined ? {} : { suggestion }),
      validate: optionalise(metadata.validate, step.optional === true),
    });
  }

  return fields;
}

/**
 * Applies one keep/edit/skip choice.
 *
 * `keep` writes the template's own value so the review shows what will be in
 * the file; `skip` clears it, which `envAnswers` drops. `edit` leaves whatever
 * is there for the field below to replace.
 */
export function applyOptionMode(
  answers: InstallAnswers,
  key: string,
  mode: OptionMode,
  spec: EnvVarSpec | undefined,
): InstallAnswers {
  const next = withAnswer(answers, optionModeField(key), mode);
  if (mode === 'skip') return withAnswer(next, key, '');
  if (mode === 'keep') {
    return withAnswer(next, key, spec === undefined || spec.optional ? '' : spec.defaultValue);
  }
  return next;
}

function helpFor(spec: EnvVarSpec, metadata: EnvVarMetadata): string {
  return [spec.help, metadata.help ?? ''].filter((text) => text !== '').join('\n');
}

/**
 * What the empty field shows.
 *
 * NO HOSTNAME IS EVER PRE-FILLED FOR POSTGRES_HOST (decision 2 of epic #118),
 * and the rule generalises: `.env.example` ships `POSTGRES_USER=postgres` and
 * `POSTGRES_PASSWORD=postgres`, which are placeholders nobody chose. An
 * ESSENTIAL key therefore offers nothing unless its default is a real answer
 * (`defaultAcceptable`, i.e. `POSTGRES_SSL=false`) — the same distinction
 * `resolveUnattended` draws in env-wizard.ts.
 */
function placeholderFor(
  spec: EnvVarSpec,
  metadata: EnvVarMetadata,
  suggestion: Suggestion | undefined,
): string {
  if (suggestion !== undefined) return suggestion.value;
  if (metadata.essential === true && metadata.defaultAcceptable !== true) return '';
  return spec.optional ? '' : spec.defaultValue;
}

/** On an optional step a blank answer skips the key, so it is never invalid. */
function optionalise(
  validate: ((value: string) => string | undefined) | undefined,
  optional: boolean,
): ((value: string) => string | undefined) | undefined {
  if (validate === undefined) return undefined;
  if (!optional) return validate;
  return (value) => (value === '' ? undefined : validate(value));
}

// -----------------------------------------------------------------------------
// Generated secrets
// -----------------------------------------------------------------------------

/** The keys of `step` that this wizard generates a value for. */
export function generatedKeys(step: InstallStep, specs: readonly EnvVarSpec[]): string[] {
  const known = new Set(specs.map((spec) => spec.key));
  return step.fields.filter((ref) => known.has(ref) && metadataFor(ref).generate !== undefined);
}

/**
 * Fills every generate-mode secret of `step` that has no value yet.
 *
 * Run when the step OPENS rather than when it closes, so the operator sees
 * the masked value that was chosen for them and can replace it — "generated"
 * is a default they are shown, never something applied behind the review.
 */
export function ensureGeneratedSecrets(
  answers: InstallAnswers,
  step: InstallStep,
  specs: readonly EnvVarSpec[],
  generate: () => string = generateBase64Key,
): InstallAnswers {
  let next = answers;
  for (const key of generatedKeys(step, specs)) {
    const mode = next[secretModeField(key)] ?? 'generate';
    next = withAnswer(next, secretModeField(key), mode);
    if (mode === 'generate' && (next[key] ?? '') === '') {
      next = withAnswer(next, key, generate());
    }
  }
  return next;
}

/**
 * Defaults every catch-all key's keep/edit/skip choice to `keep`, and puts
 * the template's own value behind it — so the review table shows what will be
 * written rather than a blank the operator has to infer a default for.
 */
export function ensureOptionModes(
  answers: InstallAnswers,
  step: InstallStep,
  specs: readonly EnvVarSpec[],
): InstallAnswers {
  if (!isCatchAllStep(step.id)) return answers;

  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  let next = answers;
  for (const ref of step.fields) {
    const spec = byKey.get(ref);
    if (spec === undefined) continue;
    if (next[optionModeField(ref)] !== undefined) continue;
    next = applyOptionMode(next, ref, 'keep', spec);
  }
  return next;
}

/** Everything a step needs filled in before it is first drawn. */
export function prepareStep(
  answers: InstallAnswers,
  step: InstallStep,
  specs: readonly EnvVarSpec[],
  generate: () => string = generateBase64Key,
): InstallAnswers {
  return ensureOptionModes(ensureGeneratedSecrets(answers, step, specs, generate), step, specs);
}

/** Switching to `paste` clears the generated value; back to `generate` mints a new one. */
export function applySecretMode(
  answers: InstallAnswers,
  key: string,
  mode: SecretMode,
  generate: () => string = generateBase64Key,
): InstallAnswers {
  const next = withAnswer(answers, secretModeField(key), mode);
  return mode === 'generate' ? withAnswer(next, key, generate()) : withAnswer(next, key, '');
}

// -----------------------------------------------------------------------------
// Checks
// -----------------------------------------------------------------------------

/**
 * The checks Welcome runs live.
 *
 * Every REQUIRED check except devnet — the `network` step creates that
 * network, so failing on its absence would refuse the very install that fixes
 * it, exactly as install's own preflight reasons (`buildInstallSteps`). The
 * proxy checks are NOT skipped here: `skipProxy: false` is the whole point of
 * running the doctor while the operator watches.
 */
export function welcomeChecks(checks: readonly Check[] = ALL_CHECKS): Check[] {
  return requiredChecks(checks).filter((check) => check.id !== DEVNET_CHECK_ID);
}

/**
 * The app name the operator has settled on, or undefined while the field is
 * still blank.
 *
 * `FALLBACK_APP_NAME` is a fine default for a PATH - `<apps root>/app` is
 * somewhere to point at until a better answer arrives. It is NOT a fine
 * default for a check that compares it against what is running on this
 * server: `CheckContext.name` is documented as "not known yet" when absent,
 * and handing it the placeholder is what made Welcome report a healthy
 * deployment's own nginx as a foreign port conflict and refuse the reinstall
 * (#262). The two uses are separated here rather than at each call site, so a
 * later one cannot quietly pick the wrong one.
 */
export function resolvedAppName(answers: InstallAnswers): string | undefined {
  const answer = answerOf(answers, NAME_FIELD);
  return answer === '' ? undefined : answer;
}

// -----------------------------------------------------------------------------
// Re-running Welcome's checks when the app name changes  (issue #262)
// -----------------------------------------------------------------------------
//
// The App name field sits on the SAME screen as the checklist those checks
// fill in, and several of them are answered in terms of it. `ctrl-r` always
// re-ran them, but nothing on the screen said so, and the remedy printed
// under the failure pointed the operator away from the fix. So the re-run is
// automatic.
//
// Debounced, because the alternative is one full doctor pass - docker, the
// proxy container, DNS - per keystroke, on a screen where the operator is
// typing a word.
// -----------------------------------------------------------------------------

/**
 * How long the name must sit still before the checks re-run.
 *
 * Long enough that typing a four-letter name is one run rather than four,
 * short enough that the checklist visibly reacts to the answer instead of
 * feeling stuck.
 */
export const NAME_RECHECK_DEBOUNCE_MS = 500;

/** What the re-run decision is made from. Everything it reads, and nothing else. */
export interface NameRecheckState {
  /** The name has settled far enough for the doctor to have started at all. */
  ready: boolean;
  /** The first (mount) run has been started; this is about RE-running. */
  started: boolean;
  /** The name as it stands now, blank while unanswered. */
  name: string;
  /** The name the last started run was given, or undefined before the first. */
  lastChecked: string | undefined;
}

/**
 * Whether the welcome checks should be re-run for the name now in hand.
 *
 * Compared against the name the last run ACTUALLY used, not against a
 * previous render's value: the mount run and the name arriving from the
 * resolved repository land in the same commit, and a re-run scheduled for a
 * name that has already been checked is a wasted doctor pass the operator
 * watches.
 */
export function shouldRecheckName(state: NameRecheckState): boolean {
  return state.ready && state.started && state.name !== state.lastChecked;
}

/**
 * Arms the re-run, returning the canceller its effect cleanup calls.
 *
 * This IS the debounce: React runs the previous effect's cleanup before the
 * next effect, so every keystroke cancels the timer the one before it armed,
 * and only a pause actually fires.
 */
export function scheduleNameRecheck(
  run: () => void,
  delayMs: number = NAME_RECHECK_DEBOUNCE_MS,
): () => void {
  const timer = setTimeout(run, delayMs);
  return () => {
    clearTimeout(timer);
  };
}

/**
 * Which field a failing check sends the operator back to.
 *
 * A check reports a CONDITION; a wizard has to put the cursor somewhere.
 * Stated as a table rather than parsed out of the check id, so adding a check
 * whose remedy is a different field is one line here and not a regex.
 */
export const CHECK_FIELD: Readonly<Record<string, string>> = {
  'dns-resolves': DOMAIN_FIELD,
  'dns-points-here': DOMAIN_FIELD,
  'database-reachable': 'POSTGRES_HOST',
  'database-credentials': 'POSTGRES_PASSWORD',
  'database-exists': 'POSTGRES_DB',
  'database-privileges': 'POSTGRES_USER',
  'database-ssl': 'POSTGRES_SSL',
  [STORAGE_CHECK_ID]: 'S3_ENDPOINT',
};

/**
 * The field to return to after `step`'s checks failed, or undefined when
 * nothing failed. Falls back to the step's first field for a check with no
 * entry above — staying on the step is always better than advancing past it.
 */
export function failedField(
  results: readonly CompletedCheck[],
  step: InstallStep,
): string | undefined {
  const failed = results.find((result) => result.status === 'fail');
  if (failed === undefined) return undefined;
  const mapped = CHECK_FIELD[failed.id];
  if (mapped !== undefined && step.fields.includes(mapped)) return mapped;
  return step.fields[0];
}

/** True when nothing this step verified failed. A `warn` never blocks. */
export function checksAllowLeaving(results: readonly CompletedCheck[]): boolean {
  return !results.some((result) => result.status === 'fail');
}

/**
 * A checklist of `checks`, with whatever has completed so far filled in.
 *
 * Every check is listed from the start — pending, then running, then its
 * result — so the operator sees the SHAPE of the run immediately instead of
 * a list that grows for forty seconds and might be finished or might not.
 */
export function checkItems(
  checks: readonly Check[],
  results: readonly CompletedCheck[],
  running: boolean,
): ChecklistItem[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  let seenPending = false;

  return checks.map((check) => {
    const result = byId.get(check.id);
    if (result !== undefined) {
      return {
        id: check.id,
        title: check.title,
        status: result.status,
        detail: result.detail,
        ...(result.remedy === undefined ? {} : { remedy: result.remedy }),
      };
    }
    // The first unfinished check is the one in flight; the rest are pending.
    const first = !seenPending;
    seenPending = true;
    return {
      id: check.id,
      title: check.title,
      status: running && first ? ('running' as const) : ('pending' as const),
    };
  });
}

/**
 * The checklist under a step's form.
 *
 * A step that names `checkIds` shows all of them from the first frame, the
 * way Welcome does. The storage step names none — its `onLeave` is a single
 * ad-hoc probe rather than registry entries — so there its results ARE the
 * list, and the rows appear as they arrive.
 */
export function stepCheckItems(
  step: InstallStep,
  results: readonly CompletedCheck[],
  running: boolean,
  registry: readonly Check[] = ALL_CHECKS,
): ChecklistItem[] {
  const ids = step.data?.checkIds ?? [];
  const declared = ids.flatMap((id) => {
    const check = registry.find((candidate) => candidate.id === id);
    return check === undefined ? [] : [check];
  });

  if (declared.length > 0) return checkItems(declared, results, running);

  return results.map((result) => ({
    id: result.id,
    title: result.title,
    status: result.status,
    detail: result.detail,
    ...(result.remedy === undefined ? {} : { remedy: result.remedy }),
  }));
}

/** The required failures, in the order they were reported. */
export function requiredFailures(results: readonly CompletedCheck[]): CompletedCheck[] {
  return results.filter(
    (result) => result.severity === 'required' && result.status === 'fail',
  );
}

// -----------------------------------------------------------------------------
// Review
// -----------------------------------------------------------------------------

export interface ReviewInput {
  specs: readonly EnvVarSpec[];
  answers: InstallAnswers;
  suggestions?: Readonly<Record<string, Suggestion>> | undefined;
  facts: ServerFacts;
  /** The app folder and the compose project name — the same string (#119). */
  name: string;
  deployRoot: string;
  repoUrl: string;
  ref: string;
  /** The shared proxy container the vhost will be reloaded in. */
  proxyContainer: string;
}

/**
 * Every value the install will use, as `KeyValue` rows.
 *
 * MASKING IS DECIDED HERE AND ONLY HERE. `renderRows` drops a masked row's
 * value entirely rather than rendering it, so the only way to put a secret on
 * screen is to not mark it — which is why this function reads `metadataFor`
 * for every env row instead of listing the secrets it knows about.
 */
export function reviewRows(input: ReviewInput): KeyValueRow[] {
  const { answers } = input;
  const context = stepContextFor(answers, input.facts);
  const suggestions = input.suggestions ?? {};
  const rows: KeyValueRow[] = [];

  const domain = answerOf(answers, DOMAIN_FIELD);

  rows.push({ key: 'Domain', value: domain === '' ? '(none)' : domain });
  rows.push({ key: 'App / compose project', value: input.name });
  rows.push({ key: 'Deploy root', value: input.deployRoot });
  rows.push({ key: 'Repository', value: input.repoUrl });
  rows.push({ key: 'Ref', value: input.ref });
  rows.push({ key: 'Proxy container', value: input.proxyContainer });

  // Derived, never asked, and shown because the two of them disagreeing with
  // the certificate is the single most common failure in a hand-built .env.
  if (domain !== '') {
    rows.push({ key: 'APP_URL', value: `https://${domain}`, note: 'derived from the domain' });
    const redirect = googleRedirectUri(context);
    if (redirect !== undefined) {
      rows.push({ key: 'GOOGLE_CALLBACK_URL', value: redirect, note: 'derived from the domain' });
    }
  }

  for (const spec of input.specs) {
    const value = answers[spec.key];
    if (value === undefined || value === '') continue;
    const metadata = metadataFor(spec.key);
    const suggestion = suggestions[spec.key];
    rows.push({
      key: spec.key,
      value,
      ...(metadata.secret === true ? { masked: true } : {}),
      ...(suggestion !== undefined && suggestion.value === value
        ? { note: suggestion.reason }
        : {}),
    });
  }

  rows.push({
    key: 'TLS',
    value: isTrue(answers, STAGING_FIELD)
      ? "Let's Encrypt staging (--staging)"
      : "Let's Encrypt production",
  });
  rows.push({
    key: 'Renewal cron',
    value: isTrue(answers, INSTALL_CRON_FIELD) ? 'installed' : 'not installed',
  });

  return rows;
}

/** The context `steps.ts` intros and `googleRedirectUri` read. */
export function stepContextFor(
  answers: InstallAnswers,
  facts: ServerFacts,
): WizardStepContext {
  const domain = answerOf(answers, DOMAIN_FIELD);
  return {
    domain: domain === '' ? undefined : domain,
    answers: envAnswers(answers),
    facts,
  };
}

// -----------------------------------------------------------------------------
// Running, done, failed
// -----------------------------------------------------------------------------

/**
 * `buildInstallSteps()`'s pipeline, so the checklist has its full shape from
 * the first frame rather than growing a row every few minutes.
 *
 * Duplicated deliberately and narrowly: importing `buildInstallSteps()` to
 * read two strings would pull the whole install module — and every step's
 * closure over `docker compose` — into a component that only wants titles.
 * `install.test.ts` asserts these ids against the real pipeline, so the copy
 * cannot drift.
 */
export const PIPELINE_STEPS: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'preflight', title: 'Check prerequisites' },
  { id: 'network', title: 'Ensure the container network' },
  { id: 'auth', title: 'Authenticate with GitHub' },
  { id: 'checkout', title: 'Fetch the application' },
  { id: 'environment', title: 'Configure the environment' },
  { id: 'validate-environment', title: 'Validate the environment' },
  { id: 'build', title: 'Build images' },
  { id: 'migrate', title: 'Apply migrations' },
  { id: 'seed', title: 'Seed roles and permissions' },
  { id: 'start', title: 'Start the stack' },
  { id: 'health', title: 'Wait for health' },
  { id: 'publish', title: 'Publish behind the proxy' },
  { id: 'verify', title: 'Verify the deployment' },
];

export interface PipelineProgress {
  id: string;
  title: string;
  outcome: 'running' | 'ok' | 'skipped' | 'failed';
  durationMs?: number | undefined;
  detail?: string | undefined;
}

const OUTCOME_STATUS = {
  running: 'running',
  ok: 'pass',
  skipped: 'skip',
  failed: 'fail',
} as const;

/**
 * The pipeline as a checklist: every step listed, with per-step duration.
 *
 * `steps` is a parameter rather than the install list baked in, because the
 * update screen (#132) shows the SAME running view over a DIFFERENT eleven
 * steps. A second copy of this function would be a second place for the
 * running/ok/skipped/failed mapping and the duration suffix to drift.
 */
export function pipelineItems(
  progress: readonly PipelineProgress[],
  steps: ReadonlyArray<{ id: string; title: string }> = PIPELINE_STEPS,
): ChecklistItem[] {
  const byId = new Map(progress.map((entry) => [entry.id, entry]));
  const extra = progress.filter((entry) => !steps.some((step) => step.id === entry.id));

  return [...steps, ...extra.map((entry) => ({ id: entry.id, title: entry.title }))].map(
    (step) => {
      const entry = byId.get(step.id);
      if (entry === undefined) {
        return { id: step.id, title: step.title, status: 'pending' as const };
      }
      const detail = [
        entry.detail,
        entry.durationMs === undefined ? undefined : formatDuration(entry.durationMs),
      ]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' · ');
      return {
        id: step.id,
        title: step.title,
        status: OUTCOME_STATUS[entry.outcome],
        ...(detail === '' ? {} : { detail }),
      };
    },
  );
}

/** `2m 04s`, `41s`, `860ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Lines kept in the live log. Unbounded growth is a leak on a long build. */
export const MAX_LOG_LINES = 2_000;

/**
 * The abort prompt docs/specs/vps-deploy.md §14 asks for.
 *
 * `danger`, and — through `confirmChoices` — opening on "No, go back": the
 * thing being confirmed kills a `docker compose build` on a production
 * server, and a destructive prompt whose default is yes is one stray Enter
 * away from happening by accident.
 */
export const ABORT_DIALOG = {
  message: 'Stop the install?',
  detail: [
    'A build or migration interrupted mid-way can leave a partial deployment.',
    'Re-running install will resume safely.',
  ],
  confirmLabel: 'Yes, stop the install',
  cancelLabel: DEFAULT_CANCEL_LABEL,
  danger: true,
} as const;

/** Index the abort dialog opens on. Re-exported so a test needs one import. */
export const ABORT_DEFAULT_INDEX = CONFIRM_DEFAULT_INDEX;

export interface DoneInput {
  domain?: string | undefined;
  commitSha: string;
  journalPath: string;
  deployRoot: string;
  name: string;
  /** `runInstall`'s own sentence: log in as <admin> to claim the Admin role. */
  nextStep: string;
}

export interface DoneModel {
  title: string;
  rows: KeyValueRow[];
  /** The one thing that still has to happen before anybody is an admin. */
  nextStep: string;
}

export function doneModel(input: DoneInput): DoneModel {
  return {
    title: 'Installed',
    rows: [
      { key: 'Domain', value: input.domain ?? '(none)' },
      { key: 'App', value: input.name },
      { key: 'Revision', value: input.commitSha.slice(0, 12) },
      { key: 'Deploy root', value: input.deployRoot },
      { key: 'Journal', value: input.journalPath },
    ],
    nextStep: input.nextStep,
  };
}

export interface FailedInput {
  /** The pipeline step that failed, when one is known. */
  stepId?: string | undefined;
  message: string;
  journalPath?: string | undefined;
  domain?: string | undefined;
}

export interface FailedModel {
  title: string;
  rows: KeyValueRow[];
  message: string;
  /** The default action: install resumes, it does not start over. */
  actionLabel: string;
}

export function failedModel(input: FailedInput): FailedModel {
  const step = PIPELINE_STEPS.find((entry) => entry.id === input.stepId);
  return {
    title: 'Install failed',
    rows: [
      { key: 'Step', value: step === undefined ? (input.stepId ?? 'unknown') : step.title },
      { key: 'Domain', value: input.domain ?? '(none)' },
      { key: 'Journal', value: input.journalPath ?? '(not opened)' },
    ],
    message: input.message,
    actionLabel: 'Re-run install (resumes)',
  };
}

/** The state an aborted run leaves behind, said honestly. */
export const ABORTED_DETAIL: readonly string[] = [
  'The install was stopped. Whatever had already been written is still there.',
  'Re-running install resumes from the last completed step.',
];
