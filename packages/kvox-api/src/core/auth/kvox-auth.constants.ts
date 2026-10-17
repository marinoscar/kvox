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

/**
 * The metadata key under which `KvoxAuthFromOptions` records the permission
 * option names a route requires (`settingsRead`), resolved by `KvoxAuthGuard`
 * against the {@link KVOX_AUTH_PERMISSIONS} map of the module the controller
 * belongs to.
 *
 * @stability experimental
 */
export const KVOX_PERMISSION_KEYS_KEY = 'kvox:permission-keys';

/**
 * Injection token of a slice's permission map: option name to the permission
 * string the host chose. Each slice module provides its own map under this one
 * token (modules are not global, so the maps never collide), and
 * `KvoxAuthGuard` reads the map of the module it is instantiated in.
 *
 * @example
 * ```ts
 * { provide: KVOX_AUTH_PERMISSIONS, useValue: { settingsRead: 'system_settings:read' } }
 * ```
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_AUTH_PERMISSIONS = Symbol.for('@marinoscar/kvox/KVOX_AUTH_PERMISSIONS');
