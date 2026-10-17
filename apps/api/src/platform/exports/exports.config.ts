import { Prisma } from '@prisma/client';
import { APP_SLUG } from '@app/shared';
import { ExportsModule, registerExportSource } from '@marinoscar/platform-api/exports';

import { KVOX_CONTENT_EXPORT_SOURCE } from './kvox-content.source';
import { ExportsHostModule } from './exports-host.module';

// =============================================================================
// The platform's exports slice (issue #532, Part B of #479, epic #478)
// =============================================================================
//
// `GET /api/exports/sources`, `POST /api/exports`, `GET /api/exports` and `GET /api/exports/:id`,
// the `export.run` and `export.purge` job types (both server-only) and the daily expiry cron
// (which only enqueues). The web side is the "Download your data" card at
// `/settings/data-export` (`apps/web/src/config/userSettingsSections.tsx`).
//
// TWO SOURCES, both `scope: user` and gated by `user_settings:read`:
//
//   user-data     the platform's: the caller's own rows of every user-owned model the registry
//                 (`app-registrations/user-owned-models.ts`) marks `export: 'include'`;
//   kvox-content  this app's (`kvox-content.source.ts`): transcript speakers and segments, note
//                 history and Ask messages, each tied to the user through its PARENT row.
//
// `org-data` (an organization's rows, for `org_members:read`) is the platform's default and is
// left on: no model of this app is org-kind, so it carries none of the content above.
//
// `datamodel` is the generated client's runtime datamodel. Prisma 7's lacks `isId`, `isList`
// and composite keys, which the slice tolerates (a field named `id` is the key; a composite-key
// model is paged by offset), and it omits `Unsupported` columns (the embedding vector, the
// search vectors), which therefore never export.
//
// `kvox-content` is registered here, AFTER `forRoot`, so `user-data` stays the first (default)
// source in the dialog. The module is NOT global: it exports `ExportsService` for whoever needs it.
// =============================================================================

export const exportsModule = ExportsModule.forRoot({
  imports: [ExportsHostModule],
  datamodel: Prisma.dmmf.datamodel,
  appSlug: APP_SLUG,
});

registerExportSource(KVOX_CONTENT_EXPORT_SOURCE);
