import HubIcon from '@mui/icons-material/Hub';

import type { KvoxDestination, KvoxDestinationRoutes } from '../../core/ui/index.js';

/**
 * The navigation destination of the graph slice, as data: the app spreads it
 * into its destination table at the position its literal `knowledge` entry was
 * (between Notes and Settings), so the rail, the bottom bar and the avatar menu
 * see exactly what they saw before.
 *
 * @remarks
 * Issue #438. ONE PERMISSION, the one every `/api/graph/*` read and every
 * `/api/ask/*` route enforces (`graph:read`, seeded to all three roles), PLUS
 * the `graph` runtime feature (`ai.graphEnabled`): a deployment with connected
 * knowledge switched off shows no tab, and while the switch is unknown or loading
 * the row stays hidden, never shown and then removed.
 *
 * The icon is the same hub glyph the graph surfaces already use
 * (`GraphReviewButton`, the Organization entity icon), filled to match its
 * sibling rows.
 *
 * The ask slice adds routes under this destination, never a fifth bottom-bar
 * destination: four non-pinned tabs is the ceiling.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export const kvoxGraphDestinations: readonly KvoxDestination<'knowledge', 'graph'>[] = [
  {
    key: 'knowledge',
    label: 'Knowledge',
    compactLabel: 'Knowledge',
    Icon: HubIcon,
    path: '/graph',
    permission: 'graph:read',
    feature: 'graph',
  },
];

/**
 * The route prefixes the knowledge destination owns, keyed by destination key.
 *
 * @remarks
 * `/graph` covers the index, `/graph/entities/:id`, `/graph/explore`,
 * `/graph/overview` and `/graph/imports/:id` (#373 to #375, #387); `/ask`
 * covers `/ask` and `/ask/:conversationId` (#380). Owned whether or not the tab
 * is DRAWN: with connected knowledge off the row is hidden, and a user who
 * reaches one of these pages anyway simply sees no highlighted row. The ask
 * slice contributes routes under `/ask`, not a destination of its own, which is
 * why this record names both prefixes.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export const kvoxGraphDestinationRoutes: KvoxDestinationRoutes<'knowledge'> = {
  knowledge: ['/graph', '/ask'],
};
