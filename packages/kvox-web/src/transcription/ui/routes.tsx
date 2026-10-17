import { lazy } from 'react';

import type { KvoxRouteDef } from '../../core/ui/index.js';

/**
 * The routes of the transcription slice, as data: the app renders each one
 * inside its own guard and layout, at the position its literal route used to be.
 *
 * @remarks
 * Issue #23, epic #19. The route is gated on the same `system_settings:read`
 * string the Transcription card declares, which is the string the API's
 * transcription-settings controller enforces on its GET: `:read` and not
 * `:write`, because saving, testing the credential and removing it all need
 * write, which the page disables without it, but the configuration is worth
 * READING for anyone diagnosing why a recording never came back.
 *
 * @stability experimental
 * @extensionPoint route
 */
export const kvoxTranscriptionRoutes: readonly KvoxRouteDef[] = [
  {
    path: '/admin/settings/transcription',
    permission: 'system_settings:read',
    Component: lazy(() =>
      import('./TranscriptionSettingsPage.js').then((module) => ({
        default: module.TranscriptionSettingsPage,
      })),
    ),
  },
];
