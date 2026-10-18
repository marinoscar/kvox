/**
 * The identity values the brand paints: product name, tagline and the two
 * colours of `packages/shared/identity.json`.
 *
 * The values are not written here. `identity.generated.ts` holds them, produced
 * from the manifest by `scripts/sync-brand-identity.mjs`, because a published
 * package cannot import the private `@app/shared` workspace and the rebrand
 * codemod (`scripts/rename.mjs`) rewrites the manifest, not this package. The
 * type lives in its own file so the generated file stays a plain object literal.
 */

/**
 * The shape of {@link KVOX_BRAND}. Strings, not literals, so a rebrand needs no type edit.
 *
 * @stability experimental
 */
export interface KvoxBrand {
  /** The product name, shown in the {@link BrandLockup}. */
  readonly productName: string;
  /** The one-line tagline. */
  readonly tagline: string;
  /** The brand colour: the light primary, the mark's plate and the manifest `theme_color`. */
  readonly themeColor: string;
  /** The page background an installed app paints before its first frame. */
  readonly backgroundColor: string;
}

export { KVOX_BRAND } from './identity.generated.js';
