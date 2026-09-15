import { CLI_NAME } from '../../../branding.js';
import { formatInstant, formatUtc } from '../../../deploy/about.js';
import type { UpdateCheck } from '../../../deploy/update.js';
import {
  DEFAULT_CANCEL_LABEL,
  type ChecklistItem,
  type KeyValueRow,
} from '../../components/index.js';
import { pipelineItems, type PipelineProgress } from './install-model.js';

// =============================================================================
// The update screen, as data  (issue #132, epic #118)
// =============================================================================
//
// THE POINT OF THIS SCREEN IS THE DIFF. The screen it replaces ran the update
// immediately; the owner wants to see what is about to be applied first, and
// #123 already produces exactly that — `update --check` fetches, resolves and
// compares WITHOUT moving the clone, and stops there. So the TUI's "Checking"
// phase is a real `--check` run: it writes nothing but deploy-info's `remote`,
// and Esc during it loses nothing at all.
//
// The rendering is #123's `renderUpdateCheck` split into the two shapes ink
// draws with: four `KeyValue` rows for the header, and the commit subjects as
// `ScrollBox` lines. It is deliberately NOT a second formatter — the same
// `shortSha` width (12) and the same up-to-date sentence, so the terminal and
// the TUI never disagree about how far behind a server is.
//
// AND THE CONFIRM OPENS ON "NO". `ConfirmDialog` does that on its own
// (`CONFIRM_DEFAULT_INDEX`), which is the whole reason this screen uses it
// rather than its own list: the thing being confirmed rebuilds and restarts a
// production stack.
// =============================================================================

/** Twelve characters — the width `status`, `about` and #123 all show. */
export const SHA_WIDTH = 12;

export function shortSha(sha: string): string {
  return sha.slice(0, SHA_WIDTH);
}

export interface UpdateDiffModel {
  /** Nothing to apply: the screen shows one sentence and Enter returns. */
  upToDate: boolean;
  title: string;
  /** Current / Latest / Behind / Checked. */
  rows: KeyValueRow[];
  /** One line per commit, newest first, for the ScrollBox. */
  commits: string[];
  /** The question, or undefined when there is nothing to ask. */
  confirm:
    | {
        message: string;
        detail: string[];
        confirmLabel: string;
        cancelLabel: string;
      }
    | undefined;
}

export interface UpdateDiffOptions {
  /** The clock the "checked" relative age is measured against. */
  now?: number | undefined;
}

/**
 * What an update would bring, as the screen draws it.
 *
 * `commitsBehind === 0` is its own shape rather than a table with a zero in
 * it: there is no diff to scroll and no question to ask, so a confirm dialog
 * would be asking whether to do nothing.
 */
export function updateDiffModel(
  check: UpdateCheck,
  options: UpdateDiffOptions = {},
): UpdateDiffModel {
  const now = options.now ?? Date.now();
  const checked: KeyValueRow = {
    key: 'Checked',
    value: formatUtc(check.checkedAt),
    note: `(${relative(check.checkedAt, now)})`,
  };

  if (check.commitsBehind === 0) {
    return {
      upToDate: true,
      // The same sentence #123's `renderUpdateCheck` prints.
      title: `Already up to date at ${shortSha(check.current)}`,
      rows: [{ key: 'Revision', value: shortSha(check.current) }, checked],
      commits: [],
      confirm: undefined,
    };
  }

  const noun = check.commitsBehind === 1 ? 'commit' : 'commits';

  return {
    upToDate: false,
    title: `${check.commitsBehind} ${noun} behind`,
    rows: [
      { key: 'Current', value: shortSha(check.current) },
      { key: 'Latest', value: shortSha(check.latest) },
      { key: 'Behind', value: `${check.commitsBehind} ${noun}` },
      checked,
    ],
    // `commit.sha` is git's own `%h` (already abbreviated) and the line is
    // byte-identical to `renderUpdateCheck`'s, so the terminal and the TUI
    // show one operator the same list.
    commits: check.commits.map((commit) => `${commit.sha}  ${commit.subject}`),
    confirm: {
      message: 'Apply this update?',
      detail: [
        'This rebuilds the images, applies migrations and restarts the stack.',
        'There is no automatic rollback: a failed update hands back the previous revision.',
      ],
      confirmLabel: `Yes, update to ${shortSha(check.latest)}`,
      // Stated rather than defaulted, so the test asserts what is on screen.
      cancelLabel: DEFAULT_CANCEL_LABEL,
    },
  };
}

/** `formatInstant` minus the timestamp: the parenthesised half only. */
function relative(iso: string, now: number): string {
  const whole = formatInstant(iso, now);
  return whole.slice(whole.indexOf('(') + 1, -1);
}

// -----------------------------------------------------------------------------
// The two flags the confirm row carries
// -----------------------------------------------------------------------------

export interface UpdateFlags {
  /** `--skip-seed`. Default OFF: update re-seeds, and that is how new permissions land. */
  skipSeed: boolean;
  /** `--no-cache`: rebuild every layer. */
  noCache: boolean;
}

export const UPDATE_FLAG_DEFAULTS: UpdateFlags = { skipSeed: false, noCache: false };

/**
 * The flag line under the confirm.
 *
 * `--skip-seed` is described by what turning it ON costs, not by what it does,
 * because `update.ts`'s own header records the trap: a release that adds a
 * permission and never re-seeds ships the feature without the permission, and
 * it surfaces as a confusing 403 rather than as a deployment error.
 */
export function updateFlagRows(flags: UpdateFlags): KeyValueRow[] {
  return [
    {
      key: 's  re-seed',
      value: flags.skipSeed ? 'off (--skip-seed)' : 'on',
      note: flags.skipSeed ? '(new permissions will not be granted)' : undefined,
    },
    { key: 'c  build cache', value: flags.noCache ? 'off (--no-cache)' : 'on' },
  ];
}

/** Which half of the diff phase the keyboard is pointed at. */
export type DiffFocus = 'confirm' | 'commits';

/**
 * The keys the diff phase binds.
 *
 * BARE LETTERS ARE SAFE HERE, and this is the one place in #132 where the
 * distinction #131 drew matters in the other direction: that header forbids a
 * bare key on a screen with an editable field, and this screen has none — the
 * diff phase is a table, a scroll box and a two-item select. `ctrl-s` was
 * rejected outright: on most terminals it is XOFF and freezes the session,
 * which is a far worse outcome than the collision the modifier avoids.
 *
 * TAB IS NOT DECORATION. `ScrollBox` and `ConfirmDialog`'s `SelectInput` both
 * bind ↑/↓, and they are on screen TOGETHER here — the one layout in this
 * epic where that happens (the install wizard only ever shows its log beside
 * a confirm with the log deactivated). ink delivers the keystroke to both, so
 * ↑ would move the answer AND scroll the commits on the same press. Tab makes
 * ownership explicit and is bound by neither component, so it is the one key
 * that can arbitrate. The confirm owns it first, because the question is what
 * the operator came here to answer.
 */
export function updateDiffHints(upToDate: boolean, focus: DiffFocus = 'confirm'): string[] {
  if (upToDate) return ['enter return', 'esc back'];
  if (focus === 'commits') {
    return ['↑↓ scroll the commits', 'tab back to the answer', 'esc back'];
  }
  return ['enter select', 's re-seed', 'c cache', 'tab scroll the commits', 'esc back'];
}

// -----------------------------------------------------------------------------
// The run
// -----------------------------------------------------------------------------

/**
 * The update pipeline's steps, in its real order.
 *
 * Duplicated from `buildUpdateSteps()` for the same narrow reason
 * `PIPELINE_STEPS` is duplicated from `buildInstallSteps()`: importing the
 * module to read eleven strings would pull every step's closure over `docker
 * compose` into a component that only wants titles. `update.test.ts` asserts
 * these ids against the real pipeline, so the copy cannot drift.
 */
export const UPDATE_PIPELINE_STEPS: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'preflight', title: 'Check the essentials' },
  { id: 'auth', title: 'Authenticate with GitHub' },
  { id: 'fetch', title: 'Look for a new revision' },
  { id: 'environment-drift', title: 'Check for new environment variables' },
  { id: 'build', title: 'Build images' },
  { id: 'migrate', title: 'Apply migrations' },
  { id: 'seed', title: 'Refresh roles and permissions' },
  { id: 'restart', title: 'Restart the stack' },
  { id: 'health', title: 'Wait for the API' },
  { id: 'publish', title: 'Refresh the vhost and certificate' },
  { id: 'verify', title: 'Verify the deployment' },
];

/** The same running view the install wizard draws, over the update's steps. */
export function updateItems(progress: readonly PipelineProgress[]): ChecklistItem[] {
  return pipelineItems(progress, UPDATE_PIPELINE_STEPS);
}

export interface UpdateDoneInput {
  changed: boolean;
  commitSha: string;
  previousSha?: string | undefined;
  journalPath: string;
  durationMs: number;
}

export interface UpdateDoneModel {
  title: string;
  rows: KeyValueRow[];
}

export function updateDoneModel(input: UpdateDoneInput): UpdateDoneModel {
  return {
    title: input.changed ? 'Updated' : 'Already up to date',
    rows: [
      { key: 'Revision', value: shortSha(input.commitSha) },
      ...(input.previousSha === undefined
        ? []
        : [{ key: 'Previous revision', value: shortSha(input.previousSha) }]),
      { key: 'Journal', value: input.journalPath },
    ],
  };
}

export interface UpdateFailedInput {
  message: string;
  /** The step that was running when it stopped, when one is known. */
  stepId?: string | undefined;
  /** What was deployed before this attempt — the thing to go back to. */
  previousSha?: string | undefined;
  journalPath?: string | undefined;
}

export interface UpdateFailedModel {
  title: string;
  message: string;
  rows: KeyValueRow[];
  /**
   * The exact line `runUpdate` prints on a failure, or undefined when there
   * is no previous revision to name.
   */
  rollbackCommand: string | undefined;
  /** Why the command above is the whole recovery story. */
  detail: string[];
}

/**
 * The failed view, carrying the manual recovery path and nothing more.
 *
 * `update.ts`'s decision 2: THERE IS NO AUTOMATIC ROLLBACK, because a
 * partially-applied migration cannot be undone by checking out the old code.
 * The one honest thing to offer is the command that redeploys the previous
 * SHA, which is the same string the subcommand's error message ends with — so
 * an operator who saw the failure in a terminal and an operator who saw it
 * here type the same thing.
 */
export function updateFailedModel(input: UpdateFailedInput): UpdateFailedModel {
  const step = UPDATE_PIPELINE_STEPS.find((entry) => entry.id === input.stepId);

  return {
    title: 'Update failed',
    message: input.message,
    rows: [
      { key: 'Step', value: step === undefined ? (input.stepId ?? 'unknown') : step.title },
      { key: 'Previous revision', value: input.previousSha ?? 'unknown' },
      { key: 'Journal', value: input.journalPath ?? '(not opened)' },
    ],
    rollbackCommand:
      input.previousSha === undefined
        ? undefined
        : `${CLI_NAME} deploy update --ref ${input.previousSha} --force`,
    detail: [
      'There is no automatic rollback: a partially-applied migration cannot be',
      'undone by checking out the old code. Redeploying the previous revision is',
      'the manual path, and it is the only one this tool claims.',
    ],
  };
}

/** The abort prompt, in the shape `ABORT_DIALOG` established for install. */
export const UPDATE_ABORT_DIALOG = {
  message: 'Stop the update?',
  detail: [
    'A build or migration interrupted mid-way can leave the stack part-updated.',
    'Nothing is rolled back; re-running update starts the pipeline again.',
  ],
  confirmLabel: 'Yes, stop the update',
  cancelLabel: DEFAULT_CANCEL_LABEL,
  danger: true,
} as const;

/** The state a stopped update leaves behind, said honestly. */
export const UPDATE_ABORTED_DETAIL: readonly string[] = [
  'The update was stopped. Whatever had already been applied is still applied.',
  'Run Update again, or check the journal above for where it got to.',
];
