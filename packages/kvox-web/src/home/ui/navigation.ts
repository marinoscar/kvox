import HomeIcon from '@mui/icons-material/Home';

import type { KvoxDestination, KvoxDestinationRoutes } from '../../core/ui/index.js';

/**
 * The Home row of the navigation: the destination `createKvoxNavigation` draws first
 * when `'home'` is in its `include`.
 *
 * @remarks
 * No `permission`: Home is for every signed-in person. It owns exactly `/`, so no other
 * row lights up on the landing page and Home does not light up on any other.
 *
 * @stability experimental
 */
export const kvoxHomeDestination: KvoxDestination<'home'> = {
  key: 'home',
  label: 'Home',
  compactLabel: 'Home',
  Icon: HomeIcon,
  path: '/',
};

/**
 * The route prefixes the Home row owns, for the shell's active-row resolver.
 *
 * @stability experimental
 */
export const kvoxHomeDestinationRoutes: KvoxDestinationRoutes<'home'> = {
  home: ['/'],
};
