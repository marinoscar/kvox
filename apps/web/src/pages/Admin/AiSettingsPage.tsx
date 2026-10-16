/**
 * Admin -> Settings -> AI (`/admin/settings/ai`) — issue #477, epic #472.
 *
 * A THIN BINDING over the platform's `AiConfigPage`
 * (`@marinoscar/platform-web/ai/ui`): the master switch, the key policy, the
 * providers and their keys, hosted tools and the rate limits are the platform's,
 * gated on `ai_config:read` (controls enabled with `ai_config:write`). The page
 * that replaced this one was 1,100 lines of the same policy, hand-built.
 *
 * What the platform has no word for is this app's, and rides in the page's
 * `Sections` slot (rendered at both ends of the body; this binding uses the
 * bottom): the connected-knowledge switch, the model per task, and the default
 * model and ceilings. See {@link AiTasksSettingsSections}. They are content
 * inside this one destination, never a tab and never a card of their own.
 *
 * `slots` is a module constant: the platform keys on its identity, and a fresh
 * object per render would remount the slot on every state change.
 *
 * THE CARD CARRIES NO `feature`. This is where AI is switched on, so it must
 * stay reachable while AI is off (the models and usage cards and the user's AI
 * Provider card are the ones the switch hides).
 */

import { AiConfigPage } from '@marinoscar/platform-web/ai/ui';
import type { AiConfigPageSlots } from '@marinoscar/platform-web/ai/ui';
import type { PageSectionsSlotProps } from '@marinoscar/platform-web/core';

import { AiTasksSettingsSections } from '../../components/admin/AiTasksSettingsSections';

function KvoxAiSections({ position }: PageSectionsSlotProps) {
  return position === 'bottom' ? <AiTasksSettingsSections /> : null;
}

const slots: AiConfigPageSlots = { Sections: KvoxAiSections };

export default function AiSettingsPage() {
  return <AiConfigPage slots={slots} />;
}
