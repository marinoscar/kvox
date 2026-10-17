// The hook moved to `@marinoscar/kvox-web/core/headless` (issue #499, epic #498).
// Re-exported here so the ~45 call sites that import it from this path do not
// change; the slices that move into the package import it from there directly,
// and this file goes when the last app caller does.
export { useIsMounted } from '@marinoscar/kvox-web/core/headless';
