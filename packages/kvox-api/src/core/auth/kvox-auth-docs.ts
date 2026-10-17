import { KVOX_PERMISSIONS_KEY, KVOX_PERMISSION_KEYS_KEY } from './kvox-auth.constants.js';

// =============================================================================
// Documenting the routes KvoxAuth guards (issue #492, epic #491)
// =============================================================================
//
// `KvoxAuth` and `KvoxAuthFromOptions` only RECORD what a route needs (and attach
// the guard). What the generated API document says about it is decided later, by
// `documentKvoxAuth`, which a slice's `forRoot` calls once the permission strings
// are known, for two reasons:
//
//   • `KvoxAuthFromOptions` does not know its strings until the host has chosen
//     them, and a document that says "requires `system_settings:read`" has to
//     name the string the guard actually enforces.
//   • The host decides HOW an authenticated route is described. The web edition
//     documents it exactly as its own `@Auth(...)` does (the session security
//     scheme, the `x-rbac` extension the requirements sentence is generated
//     from, the 401 and 403 responses), so a route moved into a package keeps
//     its entry in the document byte for byte. A host that registers nothing gets
//     a plain bearer-auth marker.
//
// The hook is `setKvoxAuthDocumenter`, called once at start-up, before the slice
// modules' `forRoot` run. Without `@nestjs/swagger` (an optional peer) nothing is
// documented and nothing fails.
// =============================================================================

/** The optional `@nestjs/swagger` module, loaded on first use. */
const SWAGGER = '@nestjs/swagger';

/** Nest's metadata key for a route's path; a method without it is not a route. */
const PATH_METADATA = 'path';

/**
 * What a documenter is told about one route.
 *
 * @stability experimental
 */
export interface KvoxRouteAuthInfo {
  /** The permission strings the route enforces, resolved: option names are already mapped to the host's strings. */
  readonly permissions: readonly string[];
}

/**
 * Returns the (typically `@nestjs/swagger`) decorators that document an
 * authenticated route. Each is applied to the route's method.
 *
 * @stability experimental
 */
export type KvoxAuthDocumenter = (route: KvoxRouteAuthInfo) => ReadonlyArray<MethodDecorator>;

let documenter: KvoxAuthDocumenter | undefined;

/**
 * Sets how the host documents an authenticated route, replacing the default
 * (a plain bearer-auth marker). Call it once at start-up, before any slice
 * module's `forRoot` runs; pass `undefined` to restore the default.
 *
 * @param next - the documenter, or `undefined`.
 * @stability experimental
 * @extensionPoint
 */
export function setKvoxAuthDocumenter(next: KvoxAuthDocumenter | undefined): void {
  documenter = next;
}

/** The default: a bearer-auth marker, when `@nestjs/swagger` is installed. */
function defaultDocumenter(): ReadonlyArray<MethodDecorator> {
  try {
    const swagger = require(SWAGGER) as { ApiBearerAuth?: () => MethodDecorator };
    return swagger.ApiBearerAuth ? [swagger.ApiBearerAuth()] : [];
  } catch {
    // `@nestjs/swagger` is an optional peer: without it the route is simply not documented.
    return [];
  }
}

/** The metadata of a handler, falling back to its class (the guard's own override rule). */
function metadataOf<T>(key: string, handler: object, controller: object): T | undefined {
  return (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller)) as T | undefined;
}

/**
 * Documents every route of `controllers` that `KvoxAuth` or
 * `KvoxAuthFromOptions` guards, with the decorators the host's documenter
 * returns for the permissions the route enforces.
 *
 * A slice's `forRoot` calls it with its controllers and its permission map.
 * Calling it again replaces the earlier documentation of the same route (the
 * decorators write metadata keyed by the route, last write wins).
 *
 * @param controllers - the controller classes of the slice.
 * @param permissions - the slice's option-name to permission-string map.
 * @stability experimental
 */
export function documentKvoxAuth(
  controllers: ReadonlyArray<Function>,
  permissions: Readonly<Record<string, string>> = {},
): void {
  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;

    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

      const direct = metadataOf<string[]>(KVOX_PERMISSIONS_KEY, handler, controller);
      const keys = metadataOf<string[]>(KVOX_PERMISSION_KEYS_KEY, handler, controller);
      if (direct === undefined && keys === undefined) continue;

      const required = [...(direct ?? []), ...(keys ?? []).map((key) => permissions[key]).filter((p): p is string => !!p)];
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);

      for (const decorate of documenter ? documenter({ permissions: required }) : defaultDocumenter()) {
        decorate(prototype, name, descriptor as PropertyDescriptor);
      }
    }
  }
}
