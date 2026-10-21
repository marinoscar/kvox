/**
 * The explorer's bundled pictograms (#667, epic #661): one 24x24 glyph per
 * node type, as SVG path data, NO remote assets.
 *
 * WHY TS AND NOT `.svg` FILES. This package is compiled by `tsc`, which does
 * not copy or import `.svg` files, and sigma needs the image as a URL anyway.
 * The glyphs are therefore path strings here, and `pictogramDataUri` turns one
 * into a `data:image/svg+xml;base64,…` URL that `@sigma/node-image` draws in
 * pictogram mode (a mask tinted by the node's `iconColor`).
 *
 * WHY BASE64. `@sigma/node-image` treats a source whose path ends in `.svg` as
 * a file and `fetch()`es it, which production's `connect-src 'self' https:`
 * refuses for a `data:` or `blob:` URL. A base64 body has no `.`, so the
 * library takes its plain-`Image` path, which only needs `img-src data:` (the
 * policy already allows it).
 *
 * The glyph geometry is from Material Icons (Apache License 2.0), the same set
 * `@mui/icons-material` ships, so a pictogram matches the rest of the UI.
 */

/** The pictograms the explorer draws, keyed by a stable name. */
export const PICTOGRAMS = {
  person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4m0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4',
  building:
    'M12 7V3H2v18h20V7zM6 19H4v-2h2zm0-4H4v-2h2zm0-4H4V9h2zm0-4H4V5h2zm4 12H8v-2h2zm0-4H8v-2h2zm0-4H8V9h2zm0-4H8V5h2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8zm-2-8h-2v2h2zm0 4h-2v2h2z',
  flag: 'M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z',
  calendar:
    'M17 12h-5v5h5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1zm3 18H5V8h14z',
  tag: 'm21.41 11.58-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42M5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7',
  cube: 'm18.25 7.6-5.5-3.18c-.46-.27-1.04-.27-1.5 0L5.75 7.6c-.46.27-.75.76-.75 1.3v6.35c0 .54.29 1.03.75 1.3l5.5 3.18c.46.27 1.04.27 1.5 0l5.5-3.18c.46-.27.75-.76.75-1.3V8.9c0-.54-.29-1.03-.75-1.3M7 14.96v-4.62l4 2.32v4.61zm5-4.03L8 8.61l4-2.31 4 2.31zm1 6.34v-4.61l4-2.32v4.62zM7 2H3.5C2.67 2 2 2.67 2 3.5V7h2V4h3zm10 0h3.5c.83 0 1.5.67 1.5 1.5V7h-2V4h-3zM7 22H3.5c-.83 0-1.5-.67-1.5-1.5V17h2v3h3zm10 0h3.5c.83 0 1.5-.67 1.5-1.5V17h-2v3h-3z',
  'check-circle':
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8z',
  gavel:
    'm5.2497 8.0687 2.83-2.8268 14.1342 14.15-2.83 2.8269zm4.2361-4.2415 2.828-2.8288 5.6577 5.656-2.828 2.8288zM.999 12.3147l2.8284-2.8284 5.6569 5.6568-2.8285 2.8285zM1 21h12v2H1z',
  warning: 'M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z',
  quote: 'M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z',
  star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  plane:
    'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z',
  milestone:
    'M13 10h5l3-3-3-3h-5V2h-2v2H4v6h7v2H6l-3 3 3 3h5v4h2v-4h7v-6h-7z',
  /** Any type the ontology adds that has no glyph of its own: a ring with a dot. */
  generic:
    'M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2m0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8m0-13c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5',
  /** The "+N more" stub. */
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
} as const;

/** A key of {@link PICTOGRAMS}. */
export type PictogramName = keyof typeof PICTOGRAMS;

/** The size the glyph is rasterised at for the WebGL texture. */
export const PICTOGRAM_PX = 64;

/** The complete SVG document for one pictogram, filled with `fill`. */
export function pictogramSvg(name: PictogramName, fill = '#ffffff'): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PICTOGRAM_PX}" height="${PICTOGRAM_PX}" viewBox="0 0 24 24">` +
    `<path fill="${fill}" fill-rule="evenodd" d="${PICTOGRAMS[name]}"/></svg>`
  );
}

const cache = new Map<string, string>();

/**
 * The pictogram as a `data:image/svg+xml;base64,…` URL for `@sigma/node-image`
 * (see the file comment for why base64). Memoised: every node of a type shares
 * one URL, so sigma uploads one texture per type.
 */
export function pictogramDataUri(name: PictogramName): string {
  const hit = cache.get(name);
  if (hit) return hit;
  const uri = `data:image/svg+xml;base64,${btoa(pictogramSvg(name))}`;
  cache.set(name, uri);
  return uri;
}
