# transcription

The admin page and client of the transcription settings, the template slice of `@marinoscar/kvox-web`.

## Purpose and scope

Admin, Settings, Transcription (`/admin/settings/transcription`): choose the speech-to-text provider, hold its write-only API key, test a key before saving it, remove a stored key, and control what happens to audio once transcribed. The slice holds the client of `/api/transcription-settings` and `/api/transcription/config`, the `useTranscriptionSettings` hook, the page, and the card and route as data. The API key is never on the wire in the response direction: the page shows a masked hint and posts a typed key once.

Status: filled (Epic 7, issue 7.1).

## Entry point

- `@marinoscar/kvox-web/transcription/headless`: `getTranscriptionSettings`, `updateTranscriptionSettings`, `testTranscriptionConnection`, `removeTranscriptionCredential`, `getTranscriptionConfig` (each takes the host first), `useTranscriptionSettings` and the wire types.
- `@marinoscar/kvox-web/transcription/ui`: `TranscriptionSettingsPage`, `kvoxTranscriptionAdminSections` and `kvoxTranscriptionRoutes`.

The slice depends on `core`. The app spreads `kvoxTranscriptionAdminSections.general` into the General section of its admin registry (same position, after Web Push and before AI) and renders `kvoxTranscriptionRoutes` where its literal route used to be.

## Peer dependencies

`@marinoscar/kvox-contract`, `react` and `react-dom` for the headless entry; `ui` adds `@mui/material`, `@mui/icons-material` and `react-router-dom`, optional peers of the package.

## Configuration

None. The page reads its host (`useKvoxHost`).

## Extension-point catalog

- `renderSecretField` (prop of `TranscriptionSettingsPage`, `(props: KvoxSecretFieldProps) => ReactNode`): renders the API key control. A host with its own secret input (masking, reveal, paste handling) supplies it; the slice never imports one. The default is a plain MUI password field. The function runs inside its own component, so it may use hooks. It receives the draft, a change handler, the disabled flag and the helper text, never a stored key.
- `kvoxTranscriptionAdminSections`: one card, `{ title: 'Transcription', path: '/admin/settings/transcription', permission: 'system_settings:read' }`. The permission is the exact string `transcription-settings.controller.ts` enforces on its GET: the page edits the `transcription` namespace of the `global` system settings row, so it has no permission pair of its own.
- `kvoxTranscriptionRoutes`: one route on the same path, gated on the same permission. Saving, testing and removing the key need `system_settings:write`, which the page checks itself and answers by disabling its controls: the card gate is about reachability, and the configuration is worth reading for anyone diagnosing why a recording never came back. The page also redirects home when it is mounted without `system_settings:read`.

### Desktop

Desktop spreads `kvoxTranscriptionAdminSections` and `kvoxTranscriptionRoutes` into its own navigation, gated by the same `system_settings:read` string the API enforces. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#wiring-the-web).
