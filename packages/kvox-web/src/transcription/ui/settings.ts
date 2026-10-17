import RecordVoiceOverOutlinedIcon from '@mui/icons-material/RecordVoiceOverOutlined';

import type { KvoxSettingsCard } from '../../core/ui/index.js';

/**
 * The admin settings cards of the transcription slice, by hub section.
 *
 * @stability experimental
 */
export interface KvoxTranscriptionAdminSections {
  /** The cards of the `General` section, in order. */
  readonly general: readonly KvoxSettingsCard[];
}

/**
 * The admin settings cards of the transcription slice, as data: the app spreads
 * `kvoxTranscriptionAdminSections.general` into its `General` section where its
 * Transcription card used to be written out.
 *
 * @stability experimental
 * @extensionPoint settings-card
 */
export const kvoxTranscriptionAdminSections: KvoxTranscriptionAdminSections = {
  general: [
    {
      // Issue #23, epic #19. `system_settings:read` is the string
      // `transcription-settings.controller.ts` enforces on its GET — the
      // registry never invents a permission, it mirrors one. And here it is
      // literally the same row: this page edits the `transcription`
      // NAMESPACE of the `global` system_settings row, which
      // `system-settings.controller.ts` already gates on exactly these
      // strings, so a permission pair of its own would mean the same bytes
      // were reachable under two different authorities.
      //
      // (Contrast `Web Push` above, which DOES have a pair of its own. That
      // split was earned by blast radius — rotating a VAPID key knocks every
      // subscriber offline. Nothing here has that property: the destructive
      // act is deleting an API key, which stops future jobs and destroys
      // nothing already stored.)
      //
      // Saving, testing and removing the key all need
      // `system_settings:write`, which the PAGE gates internally by
      // disabling its controls: the card gate is about REACHABILITY, and "is
      // transcription configured, with which provider, and is a key stored"
      // is worth reading for anyone answering "why did my recording never
      // come back".
      title: 'Transcription',
      description:
        'Choose the speech-to-text provider, hold its API key, and control what happens to audio once it has been transcribed.',
      Icon: RecordVoiceOverOutlinedIcon,
      path: '/admin/settings/transcription',
      permission: 'system_settings:read',
    },
  ],
};
