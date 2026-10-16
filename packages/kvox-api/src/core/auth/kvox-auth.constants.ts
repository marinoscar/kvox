/**
 * The metadata key under which `KvoxAuth` records the permissions a route
 * requires.
 *
 * @stability experimental
 */
export const KVOX_PERMISSIONS_KEY = 'kvox:permissions';

/**
 * The request property under which `KvoxAuthGuard` stores the authenticated
 * principal. A symbol, so it cannot collide with the host's own request fields.
 *
 * @stability experimental
 */
export const KVOX_PRINCIPAL_REQUEST_KEY: unique symbol = Symbol.for('@marinoscar/kvox/principal');
