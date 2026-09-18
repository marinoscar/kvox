/// <reference types="vite/client" />
// `virtual:pwa-register/react` — the module `components/pwa/UpdatePrompt.tsx`
// imports `useRegisterSW` from (issue #219). It exists only as a virtual module
// created by `VitePWA()` at build time, so without this reference `tsc` sees an
// unresolved import and the typecheck fails on a module the bundler resolves
// fine. Under Vitest the same specifier is resolved by an alias in
// `vitest.config.ts` — see the note there.
/// <reference types="vite-plugin-pwa/react" />

/**
 * `apps/web/package.json`'s version, substituted at build time by the `define`
 * in `vite.config.ts` and `vitest.config.ts` (issue #296).
 *
 * Declared here rather than imported, because it is not a module: `define`
 * performs a textual substitution, so by the time any code runs there is no
 * global left to resolve — only the literal it was replaced with.
 */
declare const __APP_VERSION__: string;
