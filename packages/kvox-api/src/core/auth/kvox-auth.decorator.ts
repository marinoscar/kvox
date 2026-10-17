import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';

import { KVOX_PERMISSIONS_KEY, KVOX_PERMISSION_KEYS_KEY } from './kvox-auth.constants.js';
import { KvoxAuthGuard } from './kvox-auth.guard.js';

/**
 * Protects a route or a controller: the caller must be authenticated through the
 * identity port and hold every listed permission.
 *
 * It documents nothing by itself: the owning module's `forRoot` calls
 * `documentKvoxAuth`, which describes the route in the generated API document the
 * way the host chose (a bearer-auth marker by default). With no permission it
 * requires authentication only.
 *
 * @example
 * ```ts
 * @KvoxAuth('transcripts:read')
 * @Get(':id')
 * get(@CurrentKvoxPrincipal() who: KvoxPrincipal) { ... }
 * ```
 *
 * @param permissions - permission strings the caller must all hold.
 * @returns the combined decorator.
 * @stability experimental
 */
export function KvoxAuth(...permissions: string[]): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SetMetadata(KVOX_PERMISSIONS_KEY, permissions),
    UseGuards(KvoxAuthGuard),
  );
}

/**
 * Like {@link KvoxAuth}, for a route whose permission strings belong to the host:
 * it names options (`settingsRead`) and `KvoxAuthGuard` resolves them against
 * the slice module's {@link KVOX_AUTH_PERMISSIONS} map, so the host decides the
 * strings in `forRoot` and the controller never hard-codes one.
 *
 * @example
 * ```ts
 * @KvoxAuthFromOptions('settingsRead')
 * @Get()
 * read(@CurrentKvoxPrincipal() who: KvoxPrincipal) { ... }
 * ```
 *
 * @param keys - names in the slice's permission map; the caller must hold every mapped permission.
 * @returns the combined decorator.
 * @stability experimental
 */
export function KvoxAuthFromOptions(...keys: string[]): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SetMetadata(KVOX_PERMISSION_KEYS_KEY, keys),
    UseGuards(KvoxAuthGuard),
  );
}
