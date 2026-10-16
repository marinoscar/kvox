import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';

import { KVOX_PERMISSIONS_KEY } from './kvox-auth.constants.js';
import { KvoxAuthGuard } from './kvox-auth.guard.js';

/** The optional `@nestjs/swagger` decorator, loaded on first use of `KvoxAuth`. */
const SWAGGER = '@nestjs/swagger';

function bearerDecorators(): MethodDecorator[] & ClassDecorator[] {
  try {
    const swagger = require(SWAGGER) as { ApiBearerAuth?: () => ClassDecorator & MethodDecorator };
    return swagger.ApiBearerAuth ? ([swagger.ApiBearerAuth()] as never) : ([] as never);
  } catch {
    // `@nestjs/swagger` is an optional peer: without it the route is simply not documented.
    return [] as never;
  }
}

/**
 * Protects a route or a controller: the caller must be authenticated through the
 * identity port and hold every listed permission.
 *
 * Adds the bearer-auth OpenAPI marker when `@nestjs/swagger` is installed. With
 * no permission it requires authentication only.
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
    ...bearerDecorators(),
  );
}
