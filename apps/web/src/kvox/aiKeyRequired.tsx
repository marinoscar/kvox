/**
 * The web edition's "add your AI key" state (issue #55, epic #45; the component is
 * the package's since #629).
 *
 * The component, its copy and its landmark are `AiKeyRequired` of
 * `@marinoscar/kvox-web/shell`; this app contributes the one destination every AI
 * surface links to: the AI Provider page of the user settings hub.
 */

import type { ReactElement } from 'react';
import { AiKeyRequired } from '@marinoscar/kvox-web/shell';

/** The one destination. Every AI surface's empty state links here and nowhere else. */
export const AI_KEY_SETTINGS_PATH = '/settings/ai';

/** `AiKeyRequired` pointed at this app's AI Provider page: the `KeyRequired` slot of the slices. */
export function WebAiKeyRequired(): ReactElement {
  return <AiKeyRequired settingsPath={AI_KEY_SETTINGS_PATH} />;
}
