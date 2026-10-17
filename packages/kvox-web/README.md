# @marinoscar/kvox-web

The React side of the KVox domain: pages, components and hooks built on MUI, exposed one subpath per slice and split into a `headless` entry (clients, hooks, helpers; no component, no MUI) and a `ui` entry. ESM with `sideEffects: false`; it loads in plain Node ESM as well as through a bundler.

## Purpose and scope

The web slices of the domain. Every slice reads its host (the app that mounts it) through ONE port, `KvoxWebHost`, and exports its settings cards, destinations and routes as DATA that the app spreads into its own registries. The package does not own the app's router, theme, shell or settings hub. It imports no `@marinoscar/platform-*` package (rule `host-neutral`, [PACKAGES.md](../../docs/PACKAGES.md#the-host-neutral-rule)), so it runs in a host that is not the KVox web edition (KVox Desktop).

Status: in progress (Epic 7, issues 7.1 to 7.4). `core`, `transcription`, `search`, `transcripts` and `notes` are filled; `graph` and `ask` arrive in issues 7.5 and 7.6 as `./<slice>/headless` and `./<slice>/ui`.

- `@marinoscar/kvox-web/core/headless`: the host port and its provider, the viewer and permission hooks, the HTTP, event-stream and upload transports, `KvoxApiError`, polling and the domain-neutral helpers. No MUI. [README](src/core/README.md).
- `@marinoscar/kvox-web/core/ui`: the library chrome and the types of the data a slice exports (`KvoxSettingsCard`, `KvoxDestination`, `KvoxRouteDef`). Needs MUI and `react-router-dom`.
- `@marinoscar/kvox-web/core/testing`: `createFakeKvoxWebHost`, `renderWithKvoxHost`, a query-aware `matchMedia`, a fake `XMLHttpRequest` and the conformance suites. Test code only.
- `@marinoscar/kvox-web/transcription/headless`: the admin client of `/api/transcription-settings` and `/api/transcription/config`, and `useTranscriptionSettings`. [README](src/transcription/README.md).
- `@marinoscar/kvox-web/transcription/ui`: `TranscriptionSettingsPage`, `kvoxTranscriptionAdminSections` and `kvoxTranscriptionRoutes`.
- `@marinoscar/kvox-web/search/headless`: the clients of `GET /api/search`, `GET /api/search/index-status` and `POST /api/search/index`, and the `useSearch` and `useSearchIndex` hooks. [README](src/search/README.md).
- `@marinoscar/kvox-web/search/ui`: `SearchResultsView`, `SearchSnippet`, `SemanticSearchNotice`, `UserSearchIndexPage`, `kvoxSearchUserSettingsSections` and `kvoxSearchRoutes`.
- `@marinoscar/kvox-web/transcripts/headless`: the clients of `/api/transcripts/**`, the transcript, playback, name-check and upload hooks, and `KvoxUploadManagerProvider`. [README](src/transcripts/README.md).
- `@marinoscar/kvox-web/transcripts/ui`: `TranscriptsPage`, `TranscriptPage`, `TranscriptHistoryPage`, `NewTranscriptPage`, `TranscriptsLibraryView`, the page slots, `kvoxTranscriptsDestinations` and `kvoxTranscriptsRoutes`.
- `@marinoscar/kvox-web/notes/headless`: the clients of `/api/notes/**` and `/api/note-templates/**`, the note, template and export calls, the generation stream over `host.sse`, and the note and template hooks. [README](src/notes/README.md).
- `@marinoscar/kvox-web/notes/ui`: `NotesPage`, `NotePage`, `NoteHistoryPage`, `NewNotePage`, `UserNoteTemplatesPage`, `NotesLibraryView`, `TranscriptNotesSection`, `MarkdownView`, the page slots, `kvoxNotesDestinations`, `kvoxNotesUserSettingsSections` and `kvoxNotesRoutes`.

## Install and peer dependencies

```bash
npm install @marinoscar/kvox-web@next
```

Install these in the app; the package never bundles its own copy (a second copy breaks hooks and theme context). Import slices by their subpath ([the rule](../../docs/PACKAGES.md#peer-dependencies-per-slice)).

Required by every entry (`core/headless` and everything that builds on it):

| Package | Range |
|---|---|
| `@marinoscar/kvox-contract` | `>=0.0.0-0 \|\| >=0.1.0-0` (any release; the four packages ship together, see [the contract peer range](../../docs/PACKAGES.md#the-contract-peer-range)) |
| `react` | `^19.2.7` |
| `react-dom` | `^19.2.7` |

Optional peers, installed for the entries that need them. A host that uses only the `headless` entries installs none of them:

| Package | Range | Needed by |
|---|---|---|
| `@mui/material` | `^9.1.0` | `core/ui`, `core/testing`, `transcription/ui`, `search/ui`, `transcripts/ui`, `notes/ui` |
| `@mui/icons-material` | `^9.1.0` | `core/ui`, `transcription/ui`, `search/ui`, `transcripts/ui`, `notes/ui` |
| `react-router-dom` | `^7.17.0` | `core/ui`, `core/testing`, `transcription/ui`, `search/ui`, `transcripts/ui`, `notes/ui` |
| `@tanstack/react-virtual` | `^3.14.12` | `transcripts/ui` |
| `react-markdown` | `^10.1.0` | `notes/ui` |
| `remark-gfm` | `^4.0.1` | `notes/ui` |
| `@tiptap/core`, `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-table`, `@tiptap/markdown`, `@tiptap/pm` | `^3.31.3` | `notes/ui` (the visual editor, loaded lazily) |
| `@testing-library/react` | `^16.3.2` | `core/testing` |
| `@marinoscar/platform-web` | `0.1.0-next.5` | no entry: host wiring in the app only |

The per-slice data is `packages/kvox-slice-peers.json` (a slice's `entries` list the peers only one entry may import); `node scripts/kvox-packages/check-slice-peers.mjs --table` prints it.

## Quick start

The app binds the host once, above the router outlet, and every slice below it reads it:

```tsx
import { KvoxWebHostProvider, type KvoxWebHost } from '@marinoscar/kvox-web/core/headless';
import { TranscriptionSettingsPage } from '@marinoscar/kvox-web/transcription/ui';

const host: KvoxWebHost = {
  http, // request, requestBlob, postFormData, requestWithMeta over your API client
  sse, // connect (one attempt) and post
  viewer: () => ({ userId, permissions }), // or null when nobody is signed in
  links: { transcript: (id) => `/transcripts/${id}`, note: (id) => `/notes/${id}`, entity: (id) => `/graph/entities/${id}`, conversation: (id) => `/ask/${id}` },
  features: () => ({ graphEnabled: true }),
};

export function App() {
  return (
    <KvoxWebHostProvider host={host}>
      <TranscriptionSettingsPage />
    </KvoxWebHostProvider>
  );
}
```

A packaged page or hook rendered without the provider throws `KvoxHostMissingError`. The web edition's binding is `apps/web/src/platform-kvox/KvoxHostBinding.tsx`. In a test, render under `renderWithKvoxHost(ui, createFakeKvoxWebHost({ routes }))` from `@marinoscar/kvox-web/core/testing`. See the [core README](src/core/README.md).

## Configuration

None at the package level. The host object is the whole configuration; the optional `renderSecretField` slot of the transcription page is listed in the [transcription README](src/transcription/README.md).

## Extension-point catalog

- `KvoxWebHost` (`core/headless`): the one port every slice reads. Its parts are `KvoxHttpPort`, `KvoxSsePort` and the optional `KvoxUploadPort`, plus `viewer`, `links` and `features`.
- `KvoxHttpPort`, `KvoxSsePort`, `KvoxUploadPort`: the transports a host implements.
- `KvoxSettingsCard`, `KvoxDestination`, `KvoxRouteDef` (`core/ui`): the types of the data a slice exports and the app spreads into `ADMIN_SECTIONS`, `USER_SETTINGS_SECTIONS`, `DESTINATIONS` and its routes.
- `kvoxTranscriptionAdminSections`, `kvoxTranscriptionRoutes` and the `renderSecretField` slot of `TranscriptionSettingsPage` (`transcription/ui`).
- `kvoxSearchUserSettingsSections` and `kvoxSearchRoutes` (`search/ui`): the Search Indexing card (no permission, by design) and its route.
- `kvoxTranscriptsDestinations`, `kvoxTranscriptsDestinationRoutes` and `kvoxTranscriptsRoutes` (`transcripts/ui`), the slots of `TranscriptPage` (`TranscriptPageSlots`: `NotesSection`, `useSpeakerPeople`, `SelectionActions`, `HeaderActions`) and of the library (`TranscriptsLibrarySlots`: `SearchPrefix`), and the `sharing` (`TranscriptSharingAdapter`) and `ai` (`TranscriptAiAccess`) adapters. Each is listed in the [transcripts README](src/transcripts/README.md).
- `kvoxNotesDestinations`, `kvoxNotesDestinationRoutes`, `kvoxNotesUserSettingsSections` and `kvoxNotesRoutes` (`notes/ui`), the slots of `NotePage` (`NotePageSlots`: `Provider`, `useAsideWidth`, `HeaderActions`, `ProposalActions`, `SelectionActions`) and of the library (`NotesLibrarySlots`: `SearchPrefix`), and the `ai` (`NotesAiAccess`) adapter. Each is listed in the [notes README](src/notes/README.md).

## Data

None. The browser holds no data model; it reads and writes through the API. The only browser storage is the per-tab feed cache (`sessionStorage`, `core/headless` utilities) and a scroll offset, both disposable.

## Permissions and settings

Packaged pages check no permission themselves except where a slice README says so: the app's route gate does, from the `permission` the slice's route data declares. `useHasPermission(permission)` reads the host's viewer. The transcription card and route are gated on `system_settings:read`; saving, testing and removing the key need `system_settings:write`, checked inside the page. The Search Indexing card and route declare no permission: the API gates `/api/search/index-status` and `/api/search/index` on authentication alone. The transcripts destination and the list, viewer and history routes are gated on `transcripts:read`, the new-transcript route on `transcripts:write`; the pages check `transcripts:write` and `notes:*` for their own controls. The notes destination and the library, note and history routes are gated on `notes:read`, the new-note route on `notes:write`; the Note Templates card and route declare no permission (`note_templates:*` is seeded to every role and the page's real gate is the viewer's AI key).

## UI

`core/ui` ships the library chrome (`LibraryPageFrame`, `FeedCountLine`, `FeedDateSeparator`, `ActiveStatusFilterChip`), `KvoxLoadingSpinner` and `KvoxCopyButton` (the shared copy control). Pages read the MUI theme of the host; the package defines none. `LibraryPageFrame` reads `down('sm')` to place its create action; that read is a page-level choice, not one of the five coupled shell breakpoint gates (`apps/web/src/__tests__/config/breakpointGates.test.ts` scans this package too).

## Infra

None. The package ships no deployment configuration and reads no environment variable.

## Observability

None. No slice logs or measures anything in the browser.

## Security notes

`MarkdownView` ignores embedded HTML (no `rehype-raw`, no rehype passthrough): the text of a note is model output and untrusted. Pages never hold an API key and never call an AI provider from the browser; they call the API through the host's transport, and authorization stays in the API. The transcription page posts a provider key once and never renders a stored one (the API returns only a masked hint). The host owns the access token; a slice never sees it.

## Conformance suite

`describeKvoxWebConformance(harness, options)` from `@marinoscar/kvox-web/core/testing` registers two suites: `kvox-web.host-neutral` (a static scan of the package sources: no `@marinoscar/platform-*` import anywhere, and no headless file importing `@mui/*`, `@emotion/*`, a router or a `ui` folder) and `kvox-web.host` (the shape of a host: every port present, links that return paths, a viewer that is null or has a permission set). `packages/kvox-web/test/core/conformance.test.ts` runs both against the package and its fake host; `npm run check:kvox-slice-peers` enforces the same import rules.

## Upgrade notes

None. This package has not been published yet (see the [release runbook](../../docs/runbooks/release-kvox-packages.md)), so there is nothing to migrate from. The `./core` entry of the scaffold (`KVOX_WEB_CORE`) is replaced by `./core/headless`, `./core/ui` and `./core/testing`.

## Troubleshooting

`KvoxHostMissingError` means a packaged page or hook rendered without a `KvoxWebHostProvider` above it. `Invalid hook call` means two copies of React: run `node scripts/kvox-packages/check-single-instance.mjs` and align the ranges. If the host context is "missing" although a provider is mounted, two copies of this package were loaded (a bundler that pre-bundled each entry separately): load them as one. `ERR_MODULE_NOT_FOUND` from Node means a relative import lost its `.js` extension.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-kvox-packages.md): versions, publishing, rollback
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands
- [core README](src/core/README.md), [transcription README](src/transcription/README.md), [search README](src/search/README.md), [transcripts README](src/transcripts/README.md) and [notes README](src/notes/README.md): the slices

### Desktop

The renderer of KVox Desktop installs this package and provides one `KvoxWebHost` over its local server (HTTP and SSE on loopback, or IPC). The guide documents every host member and how to render the slices' routes, destinations and settings cards. See [the KVox Desktop guide](../../docs/guides/kvox-desktop.md#wiring-the-web).
