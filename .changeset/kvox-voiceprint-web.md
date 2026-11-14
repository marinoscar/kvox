---
'@marinoscar/kvox-web': minor
---

Speaker voiceprints in the web UI (#827). `graph/headless` gains the voiceprint client (`listSpeakerSuggestions`, `acceptSpeakerSuggestion`, `dismissSpeakerSuggestion`, `getEntityVoiceprint`, `forgetEntityVoiceprint`, `getVoiceprintsSummary`, `deleteAllVoiceprints`) and the hooks `useSpeakerSuggestions`, `useEntityVoiceprint` and `useVoiceprintSettings`; `GraphPreferencesSettings`/`GraphPreferencesPatch` carry the `voiceprints` opt-in. The transcript page has a new `useSpeakerSuggestions` slot (filled by `graphTranscriptPageSlots` through `useGraphSpeakerSuggestions`) that shows "Speaker A sounds like Person A · 87%" with Accept and Dismiss for a still-unnamed speaker. A Person's page shows a Voice section with "Forget voice", and the Knowledge graph settings page has a "Voice recognition" section: the opt-in behind a consent confirmation, the counts, and "Delete all voiceprints".
