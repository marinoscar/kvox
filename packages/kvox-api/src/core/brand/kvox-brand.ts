// =============================================================================
// KVOX_BRAND: what a host calls itself (issue #493, epic #491)
// =============================================================================
//
// The few places a slice prints the product's name (a PDF's title page, its
// metadata) read it from here instead of importing the host's private constants.
// A host passes `brand` to `KvoxPortsModule.forRoot`; with nothing passed the
// slice uses {@link DEFAULT_KVOX_BRAND}.
// =============================================================================

/**
 * Injection token of {@link KvoxBrand}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_BRAND = Symbol.for('@marinoscar/kvox/KVOX_BRAND');

/**
 * What the host calls itself.
 *
 * @stability experimental
 */
export interface KvoxBrand {
  /** The product's display name (`Acme Notes`). */
  appName: string;
  /** The product's file-name and identifier slug (`acme-notes`). */
  appSlug: string;
}

/**
 * The brand used when the host passes none.
 *
 * @stability experimental
 */
export const DEFAULT_KVOX_BRAND: KvoxBrand = Object.freeze({ appName: 'KVox', appSlug: 'kvox' });
