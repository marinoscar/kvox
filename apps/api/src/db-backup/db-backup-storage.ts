// =============================================================================
// Where a backup goes, and who is allowed to say so (issue #281, epic #254)
// =============================================================================
//
// Two pure decisions, extracted from the runner so that #283's `PUT` config
// endpoint can make the second one WITHOUT constructing a backup runner, and
// so that both can be tested without a storage provider, a database or a
// `pg_dump` binary.
//
// -----------------------------------------------------------------------------
// THE SERVER CHOOSES THE KEY. ALWAYS.
// -----------------------------------------------------------------------------
//
// No caller — not the admin who clicked, not the scheduler, not a future API
// body — supplies any part of a backup's storage key. A key is a write
// capability over exactly that object, and a key derived from anything a
// request carried is a path-traversal or an overwrite waiting to be found (the
// same rule `getSignedPutUrl` states in
// `storage/providers/storage-provider.interface.ts`).
//
// The derived key is:
//
//     database-backups/<slug>/<YYYY>/<MM>/<slug>-<YYYYMMDDTHHMMSSZ>-<runId>.dump
//
// and each part earns its place:
//
//   - `database-backups/` is a fixed, DESCRIPTIVE prefix (what these objects
//     are, not whose they are). It is what a bucket lifecycle rule, an IAM
//     policy or an operator's `aws s3 ls` targets, and it is why backups never
//     interleave with the `storage_objects` keys `ObjectsService` writes.
//   - `<slug>` is `APP_NAME` slugified — see below.
//   - `<YYYY>/<MM>` makes the prefix listable by month. A flat prefix with
//     years of nightly dumps in it is a `ListObjectsV2` that pages forever,
//     and the retention sweep in #282 is the exact caller that would pay for
//     it.
//   - The COMPACT TIMESTAMP sorts lexicographically in time order, so the
//     newest object is the last one in a listing without parsing anything.
//   - The RUN ID is what makes the key collision-free rather than merely
//     unlikely: two runs starting inside the same second (a scheduled tick and
//     a `pre_restore` backup) would otherwise derive the same key and the
//     second would silently overwrite the first. The single-active-run index
//     makes that nearly impossible; "nearly" is not a property to build an
//     overwrite on.
//
// -----------------------------------------------------------------------------
// THE NAME COMPONENT IS DERIVED FROM `APP_NAME`, NOT WRITTEN OUT
// -----------------------------------------------------------------------------
//
// This repository is a template: nothing in it may hard-code an application,
// product or repository name. `packages/shared`'s `APP_NAME` is the one line a
// fork edits to rebrand, and slugifying it here means two applications built
// from this template can share one bucket without their backups colliding —
// exactly the argument `jobs/job-temp.ts` makes for its temp-file prefix.
//
// `slugifyAppName` is a near-copy of the private helper in `job-temp.ts`
// rather than an import, and that is deliberate: `job-temp.ts` exports the
// PREFIX, not the function, and reaching into the job queue's internals to
// build a storage key would couple two subsystems that have nothing to do with
// each other. The duplicated code is nine lines with a test each.
//
// -----------------------------------------------------------------------------
// ONE PROVIDER, AND THE SETTING MUST AGREE WITH IT
// -----------------------------------------------------------------------------
//
// `StorageProvidersModule` binds exactly one implementation to
// `STORAGE_PROVIDER`. `databaseBackup.storageProvider` therefore cannot select
// anything — but it is not dead weight either: it is the field a fork that
// grows a second provider will use, and today it is the field that catches an
// operator who set it to `gcs` and believed their backups were going to Google
// Cloud Storage. So the rule is: EMPTY (or absent) means "whatever is active",
// anything else must equal the active provider's id, and a mismatch is a loud
// 400 rather than a silent write to the wrong place.
//
// REJECTED: ignoring the setting when it disagrees. A backup that lands
// somewhere other than where the settings page says it lands is the single
// most dangerous kind of wrong in this subsystem, because it is only ever
// discovered during a restore.
// =============================================================================

import { APP_NAME } from '@app/shared';

import { DatabaseBackupStorageProviderError } from './db-backup.errors';

/**
 * The id of the provider `StorageProvidersModule` binds today.
 *
 * A constant rather than something read off the provider instance, because
 * `StorageProvider` has no id on it and adding one would change an interface
 * every implementation must satisfy for a single string. This mirrors
 * `ObjectsService`, which stamps the literal `'s3'` into
 * `storage_objects.storage_provider` for the identical reason — the two must
 * agree, or a fork's second provider would be half-adopted.
 */
export const ACTIVE_STORAGE_PROVIDER_ID = 's3';

/** The fixed, product-neutral prefix every backup object lives under. */
export const BACKUP_KEY_PREFIX = 'database-backups/';

/**
 * The archive format recorded on every run, and the only one this repository
 * writes: `pg_dump -Fc`. See `buildPgDumpArgs` for why custom format is the
 * only one `pg_restore` can list, filter and restore in parallel.
 */
export const BACKUP_ARCHIVE_FORMAT = 'custom';

/**
 * The `Content-Type` a backup object is stored with.
 *
 * Deliberately opaque: a custom-format archive is compressed binary with no
 * registered media type, and claiming `application/gzip` would be a lie that
 * some client eventually acts on by trying to gunzip it.
 */
export const BACKUP_CONTENT_TYPE = 'application/octet-stream';

/** What the slug degrades to when `APP_NAME` slugifies to nothing. Carries no product name. */
const NEUTRAL_SLUG = 'app';

/**
 * A display name to a key-safe slug (`'Some Name'` → `'some-name'`).
 *
 * Falls back to {@link NEUTRAL_SLUG} rather than to an empty string, because
 * an empty component would collapse `<slug>-<timestamp>` into `-<timestamp>`
 * and produce a doubled separator in the prefix — cosmetic here, but the same
 * fallback in `job-temp.ts` is a genuine safety property, and having the two
 * behave differently is how someone later "fixes" the wrong one.
 */
function slugifyAppName(name: string = APP_NAME): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.length > 0 ? slug : NEUTRAL_SLUG;
}

/** The slugified application name used in every backup key. Computed once; `APP_NAME` is a build-time constant. */
export const BACKUP_NAME_SLUG = slugifyAppName();

/**
 * `2026-09-07T02:00:00.000Z` → `20260907T020000Z`.
 *
 * UTC, unconditionally, and NOT the operator's `databaseBackup.timezone`. The
 * schedule is expressed in their timezone because that is when they want the
 * dump to run; the key is expressed in UTC because it is an identifier that
 * must stay sortable and unambiguous across a DST transition — a local-time
 * key repeats an hour every autumn.
 */
export function compactTimestamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The storage key for one backup run. Server-chosen, collision-free, sortable.
 *
 * @param at the run's start time — the caller's clock, so the key and the row
 * cannot disagree about when the backup happened.
 * @param runId the run's own id, generated before the insert precisely so the
 * key can contain it.
 */
export function buildBackupStorageKey(at: Date, runId: string): string {
  const year = at.getUTCFullYear().toString().padStart(4, '0');
  const month = (at.getUTCMonth() + 1).toString().padStart(2, '0');

  return (
    `${BACKUP_KEY_PREFIX}${BACKUP_NAME_SLUG}/${year}/${month}/` +
    `${BACKUP_NAME_SLUG}-${compactTimestamp(at)}-${runId}.dump`
  );
}

/**
 * Whether a `databaseBackup.storageProvider` value is usable by this
 * deployment.
 *
 * Empty/whitespace/absent is TRUE — it means "whatever provider is active",
 * which is the correct default for a template that binds one. Anything else
 * must match {@link ACTIVE_STORAGE_PROVIDER_ID} exactly, compared
 * case-insensitively and trimmed because the value is typed by a human into a
 * settings form.
 */
export function isUsableStorageProvider(
  configured: string | null | undefined,
  active: string = ACTIVE_STORAGE_PROVIDER_ID
): boolean {
  const trimmed = (configured ?? '').trim();

  return trimmed === '' || trimmed.toLowerCase() === active.toLowerCase();
}

/**
 * {@link isUsableStorageProvider}, as an assertion.
 *
 * THE ONE VALIDATION HELPER, called from both sides: #283's `PUT` config
 * endpoint (so a wrong value is rejected at the moment it is typed) and the
 * runner itself (so a wrong value that predates the check — a seed, a restored
 * settings blob, a provider swap — cannot quietly redirect tonight's backup).
 * Two call sites, one rule; a second copy of this comparison is how the form
 * and the runner start disagreeing.
 *
 * @throws {DatabaseBackupStorageProviderError} which #283 maps to a 400.
 */
export function assertUsableStorageProvider(
  configured: string | null | undefined,
  active: string = ACTIVE_STORAGE_PROVIDER_ID
): void {
  if (!isUsableStorageProvider(configured, active)) {
    throw new DatabaseBackupStorageProviderError((configured ?? '').trim(), active);
  }
}
