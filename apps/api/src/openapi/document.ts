// =============================================================================
// This app's OpenAPI options (issue #464, epic #462)
// =============================================================================
//
// The document and the Scalar page are built by the platform host slice
// (`createOpenApiDocument` and `registerPlatformDocs` from
// `@marinoscar/platform-api/host`): the `{ data, meta }` envelope on every 2xx
// schema, nullable normalisation, the RBAC requirement text, security schemes,
// operation ids and `x-tagGroups`. This file is the whole of what the app
// supplies: its identity and its version. `main.ts` and `scripts/dump-openapi.ts`
// both pass `APP_OPENAPI`, so the document CI lints is the document users get.
//
// The tag taxonomy is registered by `./tags` (imported here for its side effect,
// before the application bootstraps). The Markdown intro is the platform's:
// the one this app used to carry was word-for-word the same.
// =============================================================================

import { APP_NAME, REPO_URL } from '@app/shared';
import type { PlatformOpenApiOptions } from '@marinoscar/platform-api/host';

import './tags';
import { resolveApiVersion } from './version';

export const APP_OPENAPI: PlatformOpenApiOptions = {
  appName: APP_NAME,
  repoUrl: REPO_URL,
  version: resolveApiVersion,
};
