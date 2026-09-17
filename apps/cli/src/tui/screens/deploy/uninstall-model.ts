import { CLI_NAME } from '../../../branding.js';
import { describeDatabase } from '../../../deploy/database-drop.js';
import { describeInventory } from '../../../deploy/storage-purge.js';
import type { UninstallResult } from '../../../deploy/uninstall.js';
import type { ChecklistItem, KeyValueRow } from '../../components/index.js';

// =============================================================================
// The uninstall screen, as data  (issue #268)
// =============================================================================
//
// THE SCREEN RENDERS; IT DOES NOT DECIDE. Every value below is derived from
// what `runUninstall` was given or answered - the same rule
// `certificates-model.ts` states. There is no second teardown here, and there
// must never be: the TUI calls the identical `runUninstall` the subcommand
// calls, with `nonInteractive: true` (readline cannot prompt under ink's raw
// mode - `install.tsx`'s rule) and the typed confirmations supplied as the
// values the flags would have carried.
//
// THAT IS WHAT MAKES THE TUI PATH SAFE RATHER THAN MERELY CONVENIENT. Because
// the confirmations are passed as `confirmation` / `confirmBucket` /
// `confirmDatabase`, they go through the very same `requireConfirmation` and
// `requireResourceConfirmation` a scripted `--non-interactive` run does. A
// screen that set `nonInteractive: false` and let the deploy layer prompt
// would deadlock; a screen that skipped the confirmation fields would be a
// second, weaker authorisation path for the same destruction.
//
// THE EXTRAS DEFAULT TO OFF, and the options list is ordered with the
// destructive rows LAST. `confirm-dialog.tsx`'s argument, applied to a list
// rather than to two choices: the row somebody lands on first should not be
// the one that drops a database.
// =============================================================================

/** What the operator has chosen to destroy, before anything has run. */
export interface UninstallChoices {
  /** Also delete the TLS certificate. Off by default (#261's refusal 4). */
  certs: boolean;
  /** Also `DROP DATABASE`. Off by default. */
  dropDatabase: boolean;
  /** Also empty this application's prefixes in the bucket. Off by default. */
  purgeStorage: boolean;
}

export const DEFAULT_UNINSTALL_CHOICES: UninstallChoices = {
  certs: false,
  dropDatabase: false,
  purgeStorage: false,
};

export type UninstallToggle = keyof UninstallChoices;

export interface UninstallOptionRow {
  key: UninstallToggle;
  label: string;
  /** One line under it: what it costs, or why it is off. */
  note: string;
  enabled: boolean;
}

/**
 * The three opt-in rows, least destructive first.
 *
 * Every note states the CONSEQUENCE rather than the mechanism, because the
 * operator reading this has already decided to remove the deployment and is
 * now deciding how much further to go. "Let's Encrypt allows 5 duplicates a
 * week" is the fact that changes a mind; "runs certbot delete" is not.
 */
export function uninstallOptionRows(choices: UninstallChoices): UninstallOptionRow[] {
  return [
    {
      key: 'certs',
      label: 'Delete the TLS certificate',
      note: choices.certs
        ? "WILL be deleted. Let's Encrypt allows 5 duplicates a week - reissuing costs one."
        : "Kept. Reinstalling reuses it instead of spending one of Let's Encrypt's 5 a week.",
      enabled: choices.certs,
    },
    {
      key: 'purgeStorage',
      label: 'Empty the object storage',
      note: choices.purgeStorage
        ? 'WILL delete every object under this application’s own prefixes. Unrecoverable.'
        : 'Kept. Uploads, transcripts, notes and database backups all stay in the bucket.',
      enabled: choices.purgeStorage,
    },
    {
      key: 'dropDatabase',
      label: 'Drop the database',
      note: choices.dropDatabase
        ? 'WILL destroy the database and everything in it. Unrecoverable.'
        : 'Kept. The database is validated by deploy and never managed by it.',
      enabled: choices.dropDatabase,
    },
  ];
}

/** Whether anything beyond the deployment itself is going. */
export function hasDestructiveExtras(choices: UninstallChoices): boolean {
  return choices.dropDatabase || choices.purgeStorage;
}

/**
 * The confirmations this run still needs, in the order they are asked for.
 *
 * ⚠ THE APP NAME IS ALWAYS FIRST AND IS NEVER OMITTED - #261's rule, and it
 * gates the uninstall itself, so there is no point consenting to a bucket
 * being emptied by a run that is about to be refused. The extras follow in
 * the order they will actually execute (storage, then the database), which is
 * the order `buildUninstallSteps` runs them in.
 *
 * ⚠ EACH STEP CARRIES ITS OWN `expected` VALUE and nothing else. That is rule
 * 1 of #268 expressed as data: a value typed at the `bucket` step is written
 * to `confirmBucket` and can reach no other field, so it cannot authorise the
 * database drop however the screen is later rearranged.
 */
export interface ConfirmStep {
  key: 'app' | 'bucket' | 'database';
  /** The exact string that authorises this one. */
  expected: string;
  /** For the prompt: "app", "bucket", "database". */
  noun: string;
  message: string;
  detail: string[];
}

export interface ConfirmStepsInput {
  name: string;
  deployRoot: string;
  choices: UninstallChoices;
  /** The bucket's real name, from the inventory. Absent when unreadable. */
  bucket?: string | undefined;
  /** Lines describing what is in it, from `describeInventory`. */
  bucketDetail?: readonly string[] | undefined;
  /** The database's real name, from the facts. Absent when unreadable. */
  database?: string | undefined;
  databaseDetail?: readonly string[] | undefined;
}

export function confirmSteps(input: ConfirmStepsInput): ConfirmStep[] {
  const steps: ConfirmStep[] = [
    {
      key: 'app',
      expected: input.name,
      noun: 'app',
      message: `Remove ${input.name} and everything under ${input.deployRoot}?`,
      detail: [
        'The containers, the project volumes, the deploy root, this app’s vhost and its renewal cron.',
        `The .env is copied out first. The shared proxy and devnet are never touched.`,
      ],
    },
  ];

  // Offered only when the resource could actually be READ. There is no real
  // name to type otherwise, and asking for one would be asking the operator
  // to authorise something this run cannot describe.
  if (input.choices.purgeStorage && input.bucket !== undefined) {
    steps.push({
      key: 'bucket',
      expected: input.bucket,
      noun: 'bucket',
      message: `Delete this application’s objects in ${input.bucket}?`,
      detail: [...(input.bucketDetail ?? [])],
    });
  }

  if (input.choices.dropDatabase && input.database !== undefined) {
    steps.push({
      key: 'database',
      expected: input.database,
      noun: 'database',
      message: `Destroy the database ${input.database}?`,
      detail: [...(input.databaseDetail ?? [])],
    });
  }

  return steps;
}

/**
 * The inventory shown BEFORE the first confirmation (#268 requirement 2).
 *
 * Derived from a completed `--dry-run`, which is how this screen learns the
 * numbers: it runs `runUninstall` with `dryRun: true` on mount, so the lines
 * an operator consents to are the lines the real run produced from the same
 * code path, never a second description written beside it.
 */
export function inventoryLines(result: UninstallResult): string[] {
  const lines: string[] = [];
  if (result.storage !== undefined) {
    lines.push('Object storage');
    if (result.storage.problem !== undefined) {
      lines.push(`  Could not be read: ${result.storage.problem}`, '  Nothing in it will be touched.');
    } else if (result.storage.inventory !== undefined) {
      lines.push(...describeInventory(result.storage.inventory).map((line) => `  ${line}`));
    }
    lines.push('');
  }
  if (result.database !== undefined) {
    lines.push('Database');
    if (result.database.problem !== undefined) {
      lines.push(
        `  Could not be read: ${result.database.problem}`,
        '  Nothing on the server will be touched.',
      );
    } else if (result.database.facts !== undefined) {
      lines.push(...describeDatabase(result.database.facts).map((line) => `  ${line}`));
    }
    lines.push('');
  }
  return lines;
}

/** The bucket's real name from a dry run, or undefined when it was unreadable. */
export function bucketFrom(result: UninstallResult): string | undefined {
  return result.storage?.inventory?.bucket;
}

/** The database's real name from a dry run, or undefined when unreadable. */
export function databaseFrom(result: UninstallResult): string | undefined {
  const facts = result.database?.facts;
  if (facts === undefined) return undefined;
  // A database that could not be read at all has no size and a stated
  // problem; there is nothing to confirm the destruction of.
  return facts.problem === undefined ? facts.database : undefined;
}

/** What was removed, as checklist rows. */
export function removedItems(result: UninstallResult): ChecklistItem[] {
  return result.removed.map((item, index) => ({
    id: `${index}:${item.target}`,
    title: item.target,
    status: item.existed ? 'pass' : 'skip',
    ...(item.existed ? {} : { detail: 'already gone' }),
  }));
}

/** What was deliberately left alone, and why. */
export function keptRows(result: UninstallResult): KeyValueRow[] {
  return result.kept.map((item) => ({ key: item.target, value: item.reason }));
}

/**
 * The closing sentence.
 *
 * Names the two extras EXPLICITLY when they did not run, because the operator
 * who has just watched a deployment disappear is exactly the person about to
 * assume the database went with it - `runUninstallCommand`'s own reason for
 * printing the "NOT removed" block on every run, including success.
 */
export function uninstallOutcome(result: UninstallResult): string {
  if (result.dryRun) return 'Dry run complete. Nothing was changed.';

  const extras: string[] = [];
  if (result.storage === undefined) extras.push('the object storage');
  if (result.database === undefined) extras.push('the database');

  const removed = `Removed ${result.name}.`;
  if (extras.length === 0) return removed;
  return `${removed} ${extras.join(' and ')} ${extras.length === 1 ? 'was' : 'were'} left alone.`;
}

/** The keys this screen binds. */
export function uninstallHints(phase: 'options' | 'confirming' | 'running' | 'finished'): string[] {
  switch (phase) {
    case 'options':
      // A bare `space`/`enter`: the option list is a `SelectInput` and no
      // text field is mounted yet (update-model.ts's rule).
      return ['enter toggle', 'r review and remove', 'esc back'];
    case 'confirming':
      // Esc belongs to the screen; the field owns everything else.
      return ['type the name', 'enter confirm', 'esc cancel'];
    case 'running':
      return ['↑↓ scroll the output', 'esc abort'];
    case 'finished':
      return ['esc back'];
  }
}

/** The one line naming the subcommand, for somebody who wants to script it. */
export function equivalentCommand(name: string, choices: UninstallChoices): string {
  const parts = [`${CLI_NAME} deploy uninstall --name ${name} --confirm ${name}`];
  if (choices.certs) parts.push('--certs');
  if (choices.purgeStorage) parts.push('--purge-storage --confirm-bucket <bucket>');
  if (choices.dropDatabase) parts.push('--drop-database --confirm-database <database>');
  return parts.join(' ');
}
