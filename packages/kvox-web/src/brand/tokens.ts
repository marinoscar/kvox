/**
 * The brand token map. It moved to `@marinoscar/kvox-contract/brand` so the API's
 * document exporters read the same palette; this file re-exports it so the theme's
 * internal imports do not change. The reasoning behind each value is documented there.
 */

export { BRAND_TOKENS } from '@marinoscar/kvox-contract/brand';
export type { PaletteMode } from '@marinoscar/kvox-contract/brand';
