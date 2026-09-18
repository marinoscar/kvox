import type { CheckContext } from './checks/types.js';

// =============================================================================
// Emptying the object store, once and only when asked  (issue #268)
// =============================================================================
//
// `uninstall` (#261) removes the deployment. It does not remove the DATA, and
// two stores hold it: the external PostgreSQL (`database-drop.ts`) and this
// bucket. Both are opt-in, both reach OUTSIDE the deployment, and both are
// therefore built here as separate actions with their own typed confirmation -
// exactly the shape `database-create.ts` (#238) argued for and for the same
// reason: the operator sees what is there first and decides second.
//
// ⚠ THERE IS NO PER-APP KEY PREFIX, AND THAT IS THE WHOLE DIFFICULTY.
//
// This application writes at BUCKET ROOT. So "empty the bucket" and "delete
// this app's objects" coincide only when the bucket is dedicated, and on a
// shared bucket a `aws s3 rm s3://bucket --recursive` would destroy somebody
// else's data with no warning and no way back. Hence the rule this module is
// built around:
//
//   DELETE THE PREFIXES THIS APPLICATION WRITES. REPORT EVERYTHING ELSE,
//   WITHOUT READING INTO IT AND WITHOUT TOUCHING IT.
//
// That is COMPLETE for a dedicated bucket and SAFE for a shared one, and when
// it is incomplete it says so by name rather than degrading silently. The
// bucket itself is never deleted: it is infrastructure an operator created,
// often with a lifecycle policy, a CORS rule and a name that cannot be
// reclaimed for hours.
//
// WHY A ONE-OFF `aws` CONTAINER AND NOT AN SDK
//
// `checks/database.ts` already borrows a `psql` CLIENT from a one-off
// container rather than adding a PostgreSQL driver to this package, with the
// argument written out there: docker is already a hard prerequisite of every
// `deploy` subcommand, the image is cached after the first pull, and it
// behaves identically on a host with nothing installed. The same argument
// holds here, and two more besides:
//
//   - `@aws-sdk/client-s3` is ~15 MB of dependency added to a CLI that is
//     installed on a VPS to run one teardown, for a feature almost nobody
//     invokes. The API package already carries it; this one deliberately does
//     not, and the node worker never needed it either because the SERVER signs
//     every URL a node uses (`node-data-plane.service.ts`).
//   - Hand-rolling SigV4 over `node:crypto` is the other no-dependency option
//     and it is the wrong one. Versioned listings, pagination, the batch
//     delete's XML body and its content digest are a lot of security-relevant
//     surface to write once and then never exercise again except during a
//     teardown, which is the single worst moment to discover a signing bug.
//
// So: `aws s3api`, in a container, with the credentials passed BY NAME and
// never in an argv - the same rule `runPsql` states about PGPASSWORD.
// =============================================================================

/**
 * The image this module borrows an `aws` client from.
 *
 * Pinned to the v2 major rather than `latest` (which would change under a
 * deployment without warning) and not to a patch (which would go stale and
 * start failing to pull years after this line was written). `checks/database
 * .ts` pins `postgres:16-alpine` on the same reasoning: the MAJOR is the
 * compatibility promise, and nothing below it is.
 */
const AWS_IMAGE = 'amazon/aws-cli:2';

/**
 * How many keys go into one `--delete` argument.
 *
 * Deliberately well under the `DeleteObjects` API's own ceiling of 1000: the
 * payload is JSON on a command line that also crosses `docker run`, and a
 * versioned entry carries a version id as well as a key. 250 keys is a few
 * tens of kilobytes, nowhere near any ARG_MAX, and the extra round trips cost
 * nothing against a teardown.
 */
const DELETE_BATCH_SIZE = 250;

/**
 * THE PREFIXES THIS APPLICATION WRITES, derived from the API source.
 *
 * ⚠ THIS LIST IS THE ONE THING IN THIS FILE THAT GOES STALE. A new module
 * that writes under a new prefix and does not appear here leaves objects
 * behind after an operator asked for the bucket to be emptied - and the only
 * symptom is a bill. Every entry below names the file that produces it, so a
 * re-derivation is a grep rather than an audit:
 *
 *   avatars/           common/profile-image/profile-image.ts  `avatarKeyPrefix`
 *   database-backups/  db-backup/db-backup-storage.ts         `BACKUP_KEY_PREFIX`
 *   node-outputs/      nodes/node-data-plane.service.ts       `NODE_OUTPUT_KEY_PREFIX`
 *   notes/             notes/source-metadata.ts, notes/handlers/note-export.handler.ts
 *   transcripts/       transcripts/media/audio-transcode.ts and its three handlers
 *   uploads/           storage/objects/objects.service.ts
 *
 * ⚠ `database-backups/`, NOT `backups/`. A bare `backups/` appears only in
 * `db-backup`'s own test fixtures; `BACKUP_KEY_PREFIX` is the production
 * value and is what a real bucket holds.
 *
 * A handler's `deriveOutputKey` can move a node-written object off
 * `node-outputs/`, and both that do today land inside this list anyway
 * (`media-audio-transcode` writes `transcripts/…`, `db-backup-run` writes
 * `database-backups/…`) - which is the point of listing the destinations
 * rather than the writers.
 */
export const APP_KEY_PREFIXES: readonly string[] = [
  'avatars/',
  'database-backups/',
  'node-outputs/',
  'notes/',
  'transcripts/',
  'uploads/',
];

export interface StorageSettings {
  bucket: string;
  region: string;
  /** MinIO, LocalStack, R2 - empty for AWS itself. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Reads the S3_* / AWS_* values the deployment actually used.
 *
 * Mirrors `databaseSettings` deliberately, including answering `undefined`
 * for a missing environment rather than inventing defaults: the `.env` being
 * read here belongs to a deployment somebody is deleting, and a purge run
 * against a guessed bucket name is the one mistake this module must not be
 * able to make.
 */
export function storageSettings(
  env: ReadonlyMap<string, string> | undefined,
): StorageSettings | undefined {
  if (env === undefined) return undefined;
  const bucket = env.get('S3_BUCKET') ?? '';
  if (bucket === '') return undefined;
  return {
    bucket,
    region: env.get('S3_REGION') ?? 'us-east-1',
    endpoint: env.get('S3_ENDPOINT') ?? '',
    accessKeyId: env.get('AWS_ACCESS_KEY_ID') ?? '',
    secretAccessKey: env.get('AWS_SECRET_ACCESS_KEY') ?? '',
  };
}

/** Why this bucket cannot be worked with, or `undefined` when it can. */
export function storageProblem(settings: StorageSettings): string | undefined {
  if (settings.bucket === '') return 'S3_BUCKET is empty';
  if (settings.accessKeyId === '' || settings.secretAccessKey === '') {
    return 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not both set in this deployment\'s .env';
  }
  // A bucket name is never interpolated into anything but an argv here, so
  // this is not an injection guard - it is a refusal to act on a value that
  // cannot name a real bucket, before an `aws` invocation turns it into a
  // confusing 400.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(settings.bucket)) {
    return `"${settings.bucket}" is not a valid S3 bucket name`;
  }
  return undefined;
}

export type BucketVersioning = 'Enabled' | 'Suspended' | 'Disabled' | 'Unknown';

/** One of this application's prefixes, as found in the bucket. */
export interface PrefixInventory {
  prefix: string;
  objects: number;
  bytes: number;
  /**
   * Non-current versions and delete markers, on a versioned bucket. Zero
   * elsewhere. Counted separately because they are what an operator who has
   * "emptied" a versioned bucket before is still paying for.
   */
  versions: number;
}

/** Something in this bucket that is NOT this application's. Never touched. */
export interface ForeignEntry {
  /** A top-level prefix (`someone-else/`) or a loose key at the bucket root. */
  key: string;
  kind: 'prefix' | 'object';
}

export interface StorageInventory {
  bucket: string;
  region: string;
  endpoint: string;
  versioning: BucketVersioning;
  /** One entry per APP prefix that has anything in it. */
  prefixes: PrefixInventory[];
  /** Everything else at the bucket root, reported and left alone. */
  foreign: ForeignEntry[];
  objects: number;
  bytes: number;
  versions: number;
}

/** One key (and, on a versioned bucket, one version of it) to delete. */
interface DeletionTarget {
  Key: string;
  VersionId?: string;
}

/**
 * Runs one `aws` invocation in a one-off container.
 *
 * THE CREDENTIALS ARE PASSED BY NAME (`-e AWS_ACCESS_KEY_ID`) and their values
 * only through the child's environment, so neither ever appears in an argv
 * that a journal, an `onLine` hook or a thrown error could carry. That is
 * `runPsql`'s rule about PGPASSWORD, restated here because it is the one
 * property of this function that a later edit could quietly lose.
 *
 * `--network host` for the same reason the psql container uses it: an
 * `S3_ENDPOINT` pointing at a MinIO on this host is an ordinary deployment,
 * and a bridge-networked container cannot reach it.
 *
 * `AWS_EC2_METADATA_DISABLED` stops the client spending its timeout budget
 * asking an instance-metadata service for a role when the `.env` has already
 * supplied a key - and stops it silently ACQUIRING one that is not the
 * deployment's, which on an EC2 host could point the purge at a bucket the
 * operator never named.
 */
async function runAws(
  context: Pick<CheckContext, 'runCommand'>,
  settings: StorageSettings,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const argv = [
    'docker', 'run', '--rm', '--network', 'host',
    '-e', 'AWS_ACCESS_KEY_ID',
    '-e', 'AWS_SECRET_ACCESS_KEY',
    '-e', 'AWS_DEFAULT_REGION',
    '-e', 'AWS_EC2_METADATA_DISABLED',
    AWS_IMAGE,
    ...args,
    ...(settings.endpoint === '' ? [] : ['--endpoint-url', settings.endpoint]),
    '--output', 'json',
  ];

  try {
    const result = await context.runCommand(argv, {
      cwd: process.cwd(),
      timeoutMs: 10 * 60_000,
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: settings.accessKeyId,
        AWS_SECRET_ACCESS_KEY: settings.secretAccessKey,
        AWS_DEFAULT_REGION: settings.region,
        AWS_EC2_METADATA_DISABLED: 'true',
      },
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const failure = error as { result?: { stdout?: string; stderr?: string } };
    return {
      ok: false,
      stdout: (failure.result?.stdout ?? '').trim(),
      stderr:
        (failure.result?.stderr ?? '').trim() ||
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** `aws` prints nothing at all for an empty result; that is not a parse error. */
function parseJson(stdout: string): Record<string, unknown> {
  if (stdout === '') return {};
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rows(payload: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const value = payload[field];
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function str(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return typeof value === 'string' ? value : '';
}

function num(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  return typeof value === 'number' ? value : 0;
}

export class StorageAccessError extends Error {}

/**
 * Is this bucket versioned?
 *
 * ⚠ THE ANSWER CHANGES WHAT "EMPTIED" MEANS. On a versioned bucket a plain
 * delete writes a DELETE MARKER and keeps every byte - and the bill - so a
 * purge that reported success there while the data sat behind a marker would
 * be a lie told confidently. Every path below branches on this.
 *
 * An unreadable answer is `'Unknown'`, never `'Disabled'`: a role that may
 * delete objects but may not call `GetBucketVersioning` is an ordinary least-
 * privilege setup, and assuming the cheaper answer is exactly the assumption
 * that produces the silent-data-retention failure.
 */
export async function bucketVersioning(
  context: Pick<CheckContext, 'runCommand'>,
  settings: StorageSettings,
): Promise<BucketVersioning> {
  const result = await runAws(context, settings, [
    's3api', 'get-bucket-versioning', '--bucket', settings.bucket,
  ]);
  if (!result.ok) return 'Unknown';

  const status = str(parseJson(result.stdout), 'Status');
  if (status === 'Enabled') return 'Enabled';
  if (status === 'Suspended') return 'Suspended';
  // A bucket that was never versioned answers with an empty document.
  return 'Disabled';
}

/** Whether a versioning answer means non-current versions can exist. */
export function retainsVersions(versioning: BucketVersioning): boolean {
  return versioning !== 'Disabled';
}

/**
 * Everything under one prefix, as deletion targets.
 *
 * On a versioned bucket this is `list-object-versions`, which returns
 * `Versions` AND `DeleteMarkers` - both have to go, because a prefix holding
 * nothing but delete markers is still a prefix holding objects as far as the
 * bill is concerned. Elsewhere it is the cheaper `list-objects-v2`.
 *
 * The `aws` client paginates these itself and aggregates the pages into one
 * document, so there is no continuation token to carry here.
 */
async function listPrefix(
  context: Pick<CheckContext, 'runCommand'>,
  settings: StorageSettings,
  prefix: string,
  versioned: boolean,
): Promise<{ targets: DeletionTarget[]; bytes: number; current: number; extra: number }> {
  const result = await runAws(context, settings, [
    's3api',
    versioned ? 'list-object-versions' : 'list-objects-v2',
    '--bucket', settings.bucket,
    '--prefix', prefix,
  ]);
  if (!result.ok) {
    throw new StorageAccessError(`could not list ${prefix} in ${settings.bucket}: ${firstLine(result.stderr)}`);
  }

  const payload = parseJson(result.stdout);
  const targets: DeletionTarget[] = [];
  let bytes = 0;
  let current = 0;
  let extra = 0;

  if (!versioned) {
    for (const row of rows(payload, 'Contents')) {
      targets.push({ Key: str(row, 'Key') });
      bytes += num(row, 'Size');
      current += 1;
    }
    return { targets, bytes, current, extra };
  }

  for (const row of rows(payload, 'Versions')) {
    targets.push({ Key: str(row, 'Key'), VersionId: str(row, 'VersionId') });
    bytes += num(row, 'Size');
    if (row['IsLatest'] === true) current += 1;
    else extra += 1;
  }
  for (const row of rows(payload, 'DeleteMarkers')) {
    targets.push({ Key: str(row, 'Key'), VersionId: str(row, 'VersionId') });
    extra += 1;
  }
  return { targets, bytes, current, extra };
}

/**
 * What is in this bucket, before anything is confirmed.
 *
 * ⚠ THE ROOT LISTING USES `--delimiter /` ON PURPOSE. Enumerating a shared
 * bucket exhaustively to find out what else is in it could mean millions of
 * keys and a listing bill, and it would mean READING data that belongs to
 * somebody else in order to decide not to touch it. The delimiter answers the
 * only question that matters - which top-level prefixes exist - in one cheap
 * call, and anything foreign is then named without being opened.
 *
 * Loose objects sitting at the bucket root (no `/` in the key at all) come
 * back as `Contents` on that same call, and are foreign by construction: this
 * application has never written one.
 */
export async function inventoryStorage(
  context: Pick<CheckContext, 'runCommand'>,
  settings: StorageSettings,
): Promise<StorageInventory> {
  const versioning = await bucketVersioning(context, settings);
  const versioned = retainsVersions(versioning);

  const root = await runAws(context, settings, [
    's3api', 'list-objects-v2',
    '--bucket', settings.bucket,
    '--delimiter', '/',
  ]);
  if (!root.ok) {
    throw new StorageAccessError(
      `could not read ${settings.bucket}: ${firstLine(root.stderr)}`,
    );
  }

  const rootPayload = parseJson(root.stdout);
  const known = new Set(APP_KEY_PREFIXES);
  const foreign: ForeignEntry[] = [];
  const present: string[] = [];

  for (const row of rows(rootPayload, 'CommonPrefixes')) {
    const prefix = str(row, 'Prefix');
    if (prefix === '') continue;
    if (known.has(prefix)) present.push(prefix);
    else foreign.push({ key: prefix, kind: 'prefix' });
  }
  for (const row of rows(rootPayload, 'Contents')) {
    const key = str(row, 'Key');
    if (key !== '') foreign.push({ key, kind: 'object' });
  }

  const prefixes: PrefixInventory[] = [];
  let objects = 0;
  let bytes = 0;
  let versions = 0;

  for (const prefix of APP_KEY_PREFIXES) {
    if (!present.includes(prefix)) continue;
    const found = await listPrefix(context, settings, prefix, versioned);
    prefixes.push({
      prefix,
      objects: found.current,
      bytes: found.bytes,
      versions: found.extra,
    });
    objects += found.current;
    bytes += found.bytes;
    versions += found.extra;
  }

  return {
    bucket: settings.bucket,
    region: settings.region,
    endpoint: settings.endpoint,
    versioning,
    prefixes,
    foreign: foreign.sort((a, b) => a.key.localeCompare(b.key)),
    objects,
    bytes,
    versions,
  };
}

export interface PurgeStorageOptions {
  /** List what would go; issue no delete at all. */
  dryRun?: boolean | undefined;
  /** Called per prefix as it completes, for the run log. */
  onProgress?: ((message: string) => void) | undefined;
}

export interface PurgeStorageResult {
  inventory: StorageInventory;
  /** Keys actually deleted (versions included), per prefix. */
  deleted: { prefix: string; keys: number }[];
  /** Total keys deleted, or that would be. */
  keys: number;
  dryRun: boolean;
  /** Prefixes that could not be emptied, with the reason. */
  failures: string[];
  /**
   * Set when non-current versions may still exist after this run - i.e. the
   * bucket is versioned and something stopped them being deleted. Never set
   * on a clean versioned purge, which deletes every version by id.
   */
  versionsRemain?: string | undefined;
}

/**
 * Deletes exactly this application's six prefixes. Reports everything else.
 *
 * ⚠ THE FOREIGN ENTRIES ARE NEVER PASSED TO A DELETE. There is no code path
 * in this function that can construct a deletion target from
 * `inventory.foreign` - the targets come from `listPrefix`, which is only
 * ever called with a member of `APP_KEY_PREFIXES`. That is a structural
 * guarantee rather than a filter somebody could later invert, and it is the
 * shared-bucket safety property this whole module exists for.
 *
 * A prefix that fails is recorded and the rest continue: an operator tearing
 * a deployment down wants the five that worked emptied and the sixth named,
 * not an abort that leaves an arbitrary amount done and nothing said.
 */
export async function purgeStorage(
  context: Pick<CheckContext, 'runCommand'>,
  settings: StorageSettings,
  inventory: StorageInventory,
  options: PurgeStorageOptions = {},
): Promise<PurgeStorageResult> {
  const dryRun = options.dryRun === true;
  const versioned = retainsVersions(inventory.versioning);
  const deleted: { prefix: string; keys: number }[] = [];
  const failures: string[] = [];
  let keys = 0;

  for (const entry of inventory.prefixes) {
    try {
      const found = await listPrefix(context, settings, entry.prefix, versioned);
      if (found.targets.length === 0) {
        deleted.push({ prefix: entry.prefix, keys: 0 });
        continue;
      }

      if (dryRun) {
        deleted.push({ prefix: entry.prefix, keys: found.targets.length });
        keys += found.targets.length;
        options.onProgress?.(
          `would delete ${found.targets.length} key(s) under ${entry.prefix}`,
        );
        continue;
      }

      let removed = 0;
      for (let at = 0; at < found.targets.length; at += DELETE_BATCH_SIZE) {
        const batch = found.targets.slice(at, at + DELETE_BATCH_SIZE);
        const result = await runAws(context, settings, [
          's3api', 'delete-objects',
          '--bucket', settings.bucket,
          '--delete', JSON.stringify({ Objects: batch, Quiet: true }),
        ]);
        if (!result.ok) {
          throw new StorageAccessError(firstLine(result.stderr));
        }
        // `Quiet: true` suppresses the successes and keeps the errors, so a
        // non-empty `Errors` is the only thing worth reading back.
        const errors = rows(parseJson(result.stdout), 'Errors');
        if (errors.length > 0) {
          throw new StorageAccessError(
            `${errors.length} key(s) refused, first: ${str(errors[0] ?? {}, 'Key')} (${str(errors[0] ?? {}, 'Message')})`,
          );
        }
        removed += batch.length;
      }

      deleted.push({ prefix: entry.prefix, keys: removed });
      keys += removed;
      options.onProgress?.(`emptied ${entry.prefix} (${removed} key(s))`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${entry.prefix}: ${detail}`);
      options.onProgress?.(`could not empty ${entry.prefix}: ${detail}`);
    }
  }

  // Only when something actually failed on a versioned bucket. A clean
  // versioned purge deleted every version BY ID above, so nothing remains and
  // claiming otherwise would be its own kind of dishonesty.
  const versionsRemain =
    versioned && failures.length > 0
      ? `${settings.bucket} has versioning ${inventory.versioning}. The prefixes listed above were not emptied, so their ` +
        'non-current versions and delete markers still exist and are still billed.'
      : undefined;

  return {
    inventory,
    deleted,
    keys,
    dryRun,
    failures,
    ...(versionsRemain === undefined ? {} : { versionsRemain }),
  };
}

/** Bytes as an operator reads them. Base-10, matching what a cloud bill uses. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * The inventory, as the lines shown BEFORE the confirmation is asked for.
 *
 * The issue's second requirement: an operator cannot consent to a number they
 * were never shown. So this is not a summary - it is every prefix with its
 * own count and size, the versioning state spelled out in the terms that
 * decide whether the data really goes, and every foreign entry named.
 */
export function describeInventory(inventory: StorageInventory): string[] {
  const lines: string[] = [
    `Bucket   ${inventory.bucket}` +
      (inventory.endpoint === '' ? ` (${inventory.region})` : ` at ${inventory.endpoint}`),
  ];

  if (inventory.prefixes.length === 0) {
    lines.push('This application has written nothing to this bucket.');
  } else {
    for (const entry of inventory.prefixes) {
      lines.push(
        `  ${entry.prefix.padEnd(20)} ${String(entry.objects).padStart(7)} object(s)  ${formatBytes(entry.bytes)}` +
          (entry.versions > 0 ? `  + ${entry.versions} older version(s)/marker(s)` : ''),
      );
    }
    lines.push(
      `  ${'TOTAL'.padEnd(20)} ${String(inventory.objects).padStart(7)} object(s)  ${formatBytes(inventory.bytes)}` +
        (inventory.versions > 0 ? `  + ${inventory.versions} older version(s)/marker(s)` : ''),
    );
  }

  switch (inventory.versioning) {
    case 'Enabled':
    case 'Suspended':
      lines.push(
        `Versioning is ${inventory.versioning}: every version and delete marker above is deleted BY ID,`,
        'so the bytes really go. A plain delete here would only write another marker.',
      );
      break;
    case 'Unknown':
      lines.push(
        'Versioning could NOT be read (this key may not call GetBucketVersioning).',
        'Treated as versioned, so versions are deleted by id - which is a no-op on an unversioned bucket.',
      );
      break;
    case 'Disabled':
      lines.push('Versioning is off, so a delete is final.');
      break;
  }

  if (inventory.foreign.length > 0) {
    lines.push(
      '',
      `NOT this application's, NOT inspected and NOT deleted (${inventory.foreign.length}):`,
    );
    for (const entry of inventory.foreign) {
      lines.push(`  ${entry.key}${entry.kind === 'object' ? '   (loose object at the bucket root)' : ''}`);
    }
    lines.push('This bucket is shared. The bucket itself is never deleted.');
  }

  return lines;
}

function firstLine(value: string): string {
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.slice(0, 200);
  }
  return 'no output';
}
