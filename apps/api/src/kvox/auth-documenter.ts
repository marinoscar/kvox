import { ApiBearerAuth, ApiExtension, ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ErrorDto } from '@marinoscar/platform-api/core';
import { RBAC_EXTENSION_KEY } from '@marinoscar/platform-api/identity';
import { setKvoxAuthDocumenter } from '@marinoscar/kvox-api/core';

// =============================================================================
// How the web edition documents a route the packaged slices guard (issue #492, epic #491)
// =============================================================================
//
// A controller that moved into `@marinoscar/kvox-api` is guarded by `KvoxAuth`,
// which records what the route needs but documents nothing: the package cannot name
// the platform's `@Auth(...)`. Each slice's `forRoot` then asks the documenter below
// (through `documentKvoxAuth`) to describe the route, and this one emits exactly what
// `@Auth(...)` emits, so a route keeps its entry in the generated API document byte
// for byte: the session security scheme, the `x-rbac` extension the platform turns
// into the "Requires:" sentence (and the PAT scheme), and the 401 and 403 responses.
//
// IMPORT THIS FIRST in every `<slice>/<slice>.config.ts`: the documenter has to be
// set before the slice's `forRoot` runs, and ES imports evaluate in order.
// =============================================================================

setKvoxAuthDocumenter(({ permissions }) => [
  ApiBearerAuth('JWT-auth'),
  ApiExtension(RBAC_EXTENSION_KEY, { authenticated: true, roles: [], permissions: [...permissions] }),
  ApiUnauthorizedResponse({ description: 'Unauthorized - Invalid or missing token', type: ErrorDto }),
  ApiForbiddenResponse({ description: 'Forbidden - Insufficient permissions', type: ErrorDto }),
]);
