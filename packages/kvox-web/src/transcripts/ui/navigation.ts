import GraphicEqIcon from '@mui/icons-material/GraphicEq';

import type { KvoxDestination, KvoxDestinationRoutes } from '../../core/ui/index.js';

/**
 * The navigation destination of the transcripts slice, as data: the app spreads
 * it into its destination table at the position its literal `transcripts` entry
 * was (between Home and Notes), so the rail, the bottom bar and the avatar menu
 * see exactly what they saw before.
 *
 * @remarks
 * Issue #30 (epic #19), restored to a destination of its own by #106.
 *
 * ONE PERMISSION, NOT AN `anyPermission` PAIR. This row fronts exactly one
 * controller: `transcripts.controller.ts` carries
 * `@Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })` on its reads, so the
 * "or" the old `library` row needed has no meaning here. A deployment that
 * revokes transcripts and keeps notes loses this row and keeps the Notes one.
 *
 * Seeded to ALL THREE roles (recording a conversation is the action epic #19
 * exists to enable, and a new account's default role is Viewer), so in practice
 * the row is visible to everybody, but the GATE is still the permission,
 * because a deployment that revokes it must lose the row. It is not `pinned`: a
 * pinned destination is a mode (Settings, Console) and the phone bar never
 * carries one, and four non-pinned destinations is that bar's ceiling.
 *
 * Both labels say "Transcripts", and at 11 characters it is the longest
 * compact label the app ships, which is why the collapsed rail is wider than a
 * 48px caption box; check that caption when the label changes. The icon is the
 * audio waveform: the row fronts recordings.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export const kvoxTranscriptsDestinations: readonly KvoxDestination<'transcripts'>[] = [
  {
    key: 'transcripts',
    label: 'Transcripts',
    compactLabel: 'Transcripts',
    Icon: GraphicEqIcon,
    path: '/transcripts',
    permission: 'transcripts:read',
  },
];

/**
 * The route prefixes the transcripts destination owns, keyed by destination key.
 *
 * @remarks
 * ONE PREFIX. It owns its whole subtree: `/transcripts` covers the library,
 * `/transcripts/new`, `/transcripts/:id` and `/transcripts/:id/history`
 * (#30, #31, epic #19), because a reader drilled into one transcript has not
 * left the surface they started on. The app spreads it into its
 * `DESTINATION_ROUTES` at the same key position.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export const kvoxTranscriptsDestinationRoutes: KvoxDestinationRoutes<'transcripts'> = {
  transcripts: ['/transcripts'],
};
