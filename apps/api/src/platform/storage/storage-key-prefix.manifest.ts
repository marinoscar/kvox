// =============================================================================
// Object-storage key prefixes (issue #469, epic #467)
// =============================================================================
//
// Every key prefix this deployment writes under, registered before the registry
// freezes at bootstrap. A destructive path (the storage purge, org offboarding,
// the factory reset) may enumerate only this list, so a prefix that is not
// here is a prefix a purge silently leaves behind. The `storage` conformance
// suite fails on a malformed or overlapping prefix and on a missing id.
//
// PLATFORM prefixes (the storage slice's own four, then `database-backups`) are
// listed first, in the platform's purge order. `StorageModule.forRoot()` and
// `DbBackupModule` register them too; a registration identical to an existing
// one is skipped, which is what lets this manifest fix the ORDER.
//
// KVOX prefixes are `deployment` scope: this app keeps its own key builders
// (`transcripts/<id>/...`, `notes/<id>/...`, `graph/<ownerId>/...`) and does not
// adopt the `<prefix><orgId>/` layout (out of scope of #469). Existing keys
// keep their names.
// =============================================================================

import { DB_BACKUP_KEY_PREFIX } from '@marinoscar/platform-api/db-backup';
import {
  STORAGE_SLICE_KEY_PREFIXES,
  registerStorageKeyPrefixes,
  type StorageKeyPrefixDef,
} from '@marinoscar/platform-api/storage';

/** This app's own prefixes, appended after the platform's. */
export const KVOX_KEY_PREFIXES: readonly StorageKeyPrefixDef[] = [
  {
    id: 'transcripts',
    prefix: 'transcripts/',
    owner: 'transcripts',
    scope: 'deployment',
    description:
      'Transcript renditions, snapshots, raw provider results and exports: transcripts/<transcriptId>/...',
  },
  {
    id: 'notes',
    prefix: 'notes/',
    owner: 'notes',
    scope: 'deployment',
    description: 'Note exports and source documents: notes/<noteId>/exports/..., notes/sources/...',
  },
  {
    id: 'graph',
    prefix: 'graph/',
    owner: 'graph',
    scope: 'deployment',
    description: 'Graph RDF exports and imports: graph/<ownerId>/{exports,imports}/...',
  },
];

/** Every prefix this deployment registers, in purge order. */
export const ALL_KEY_PREFIXES: readonly StorageKeyPrefixDef[] = [
  ...STORAGE_SLICE_KEY_PREFIXES,
  DB_BACKUP_KEY_PREFIX,
  ...KVOX_KEY_PREFIXES,
];

let registered = false;

/** Registers {@link ALL_KEY_PREFIXES}. Idempotent per process. */
export function registerKvoxStorageKeyPrefixes(): void {
  if (registered) return;
  registered = true;
  registerStorageKeyPrefixes(ALL_KEY_PREFIXES);
}

registerKvoxStorageKeyPrefixes();
