/**
 * The npm name of this package.
 *
 * @remarks
 * The root entry point exports only this constant. Every schema, constant and
 * helper lives in a slice entry point (`@marinoscar/kvox-contract/ask`,
 * `.../graph`, ...), so a consumer imports the slice it needs and a bundler
 * drops the rest.
 *
 * @stability experimental
 */
export const KVOX_CONTRACT_PACKAGE = '@marinoscar/kvox-contract' as const;
