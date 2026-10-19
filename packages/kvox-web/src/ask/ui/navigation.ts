import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';

import type { KvoxDestination, KvoxDestinationRoutes } from '../../core/ui/index.js';

/**
 * The Ask destination of the ask slice, as data, for a host that lists Ask as a
 * row of its own (KVox Desktop's rail).
 *
 * @remarks
 * KVox web does NOT spread this: there Ask is reached from Knowledge and `/ask`
 * is owned by the `knowledge` row (`kvoxGraphDestinationRoutes`). A host that
 * lists both rows drops `/ask` from the Knowledge prefixes, which
 * `createKvoxNavigation` from `@marinoscar/kvox-web/shell` does when asked for
 * `'ask'`.
 *
 * ONE PERMISSION, the one every `/api/ask/*` route enforces (`graph:read`; there
 * is no `ask:*` pair), PLUS the `graph` runtime feature: with connected
 * knowledge off the row is hidden.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export const kvoxAskDestinations: readonly KvoxDestination<'ask', 'graph'>[] = [
  {
    key: 'ask',
    label: 'Ask',
    compactLabel: 'Ask',
    Icon: QuestionAnswerIcon,
    path: '/ask',
    permission: 'graph:read',
    feature: 'graph',
  },
];

/**
 * The route prefix the Ask destination owns, keyed by destination key: `/ask`
 * covers `/ask` and `/ask/:conversationId`.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export const kvoxAskDestinationRoutes: KvoxDestinationRoutes<'ask'> = {
  ask: ['/ask'],
};
