// =============================================================================
// The storage slice's composition (issue #469, epic #467)
// =============================================================================
//
// `StorageModule.forRoot` serves `/api/storage/objects` (the objects API, at the
// same paths this app always had, except `POST :id/upload/parts`, which
// `kvox-objects/kvox-multipart.controller.ts` adds), `GET /api/storage/status`,
// the `storage.cleanup.stale-uploads` and `storage.object.process` job types
// and the stale-upload cron (which only enqueues). `StorageConfigModule` serves
// `/api/admin/storage-config` and the `storage.*` Doctor checks.
// `ProfileImageModule.forRoot` serves `/api/user-settings/profile-image` and the
// public avatar route. They replace this app's own `storage/` folder and
// `settings/profile-image/`.
//
// The object store is RUNTIME-CONFIGURED: the active driver and its non-secret
// settings are the `storage` system-settings namespace, the secret access key is
// in the credential store (`storage/default`). The deployment's `STORAGE_PROVIDER`,
// `S3_*` and `AWS_*` environment variables are no longer read; an operator enters
// them at `/admin/settings/storage` (runbook: docs/runbooks/storage-configuration.md).
//
// ORDER: the key-prefix manifest registers before the registry freezes, and the
// profile-image controller is BUILT in `forRoot()` from the composed user-settings
// schema, so the settings registry is imported first.
//
// THE CONSTANTS BELOW ARE SINGLETONS: a module that needs `ObjectsService`
// imports `storageModule` (the same dynamic-module object), never a second
// `StorageModule.forRoot()`.
// =============================================================================

import {
  ProfileImageModule,
  StorageConfigModule,
  StorageModule,
} from '@marinoscar/platform-api/storage';

import '../../settings/registry';
import './storage-key-prefix.manifest';
import { StorageHostModule } from './storage-host.module';

/** Today's default for how long an unfinished upload is left alone (formerly `STORAGE_STALE_UPLOAD_HOURS`). */
export const STALE_UPLOAD_HOURS = 72;

export const storageModule = StorageModule.forRoot({
  imports: [StorageHostModule],
  staleUploadHours: STALE_UPLOAD_HOURS,
});

export const profileImageModule = ProfileImageModule.forRoot();

export { StorageConfigModule };
