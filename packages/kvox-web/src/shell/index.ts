// The shell entry of @marinoscar/kvox-web: the host-neutral KVox app shell that
// KVox web and KVox Desktop both render. Navigation composed from the slices'
// own destinations, the route renderer with its permission guard, the default
// in-app links, the "add your AI key" state and the shell itself.
//
// It imports the platform's shell and identity entries, which is why
// `@marinoscar/platform-web` is a peer of this entry (the `host-neutral` rule
// allows exactly those specifiers for the `shell` slice).

export { AiKeyRequired } from './AiKeyRequired.js';
export type { AiKeyRequiredProps } from './AiKeyRequired.js';
export { KvoxAppShell } from './KvoxAppShell.js';
export type { KvoxAppShellProps } from './KvoxAppShell.js';
export { defaultKvoxLinks } from './links.js';
export { createKvoxNavigation, withoutPinned } from './navigation.js';
export type {
  CreateKvoxNavigationOptions,
  KvoxNavigation,
  KvoxNavigationSlice,
  KvoxSliceDestinationKey,
} from './navigation.js';
export { renderKvoxRoutes } from './routes.js';
export type { RenderKvoxRoutesOptions } from './routes.js';
