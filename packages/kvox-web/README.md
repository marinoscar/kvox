# @marinoscar/kvox-web

The React side of the KVox domain: pages, components and hooks built on MUI, exposed one subpath per slice and split into a `headless` entry (clients, hooks, helpers; no component, no MUI) and a `ui` entry. ESM with `sideEffects: false`; it loads in plain Node ESM as well as through a bundler.

## Purpose and scope

The web slices of the domain. Every slice reads its host (the app that mounts it) through ONE port, `KvoxWebHost`, and exports its settings cards, destinations and routes as DATA that the app spreads into its own registries. The package does not own the app's router, shell or settings hub; it does own the KVox look (the `brand` entry: theme, tokens, mark, fonts), so every host paints the same. It imports no `@marinoscar/platform-*` package (rule `host-neutral`, [PACKAGES.md](../../docs/PACKAGES.md#the-host-neutral-rule)), so it runs in a host that is not the KVox web edition (KVox Desktop). The exceptions are the `brand` entry, which imports exactly `@marinoscar/platform-web/shell/headless` (`createShellTheme`), and the `shell` entry, which imports the platform's `shell/ui`, `shell/headless` and `identity/headless`.

Status: filled (Epic 7, issues 7.1 to 7.6). All the domain slices are in: `core`, `transcription`, `search`, `transcripts`, `notes`, `graph` and `ask`, with `home` (the Home page and its journey) on top. The web edition's `apps/web/src` keeps only composition (routes, registries, the shell, the host binding and the non-domain pages).

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
- `@marinoscar/kvox-web/graph/headless`: the client of `/api/graph/**`, the entity, brief, timeline, mention, evidence, proposal, ontology, preference, attribute-definition, overview, export, import and transcript-people hooks, and the pure display, span, proposal and explorer helpers. [README](src/graph/README.md).
- `@marinoscar/kvox-web/graph/ui`: `GraphIndexPage`, `GraphEntityPage`, `GraphExplorerPage`, `GraphOverviewPage`, `GraphImportPage`, `UserKnowledgeGraphPage`, `EvidenceChip`, `NeighborhoodWidget`, `SchemaForm`, the slot components for the transcript and note pages and the libraries, `kvoxGraphDestinations`, `kvoxGraphUserSettingsSections` and `kvoxGraphRoutes`.
- `@marinoscar/kvox-web/graph/testing`: `mockGraphCanvas`, the stand-in for the WebGL canvases. Test code only.
- `@marinoscar/kvox-web/ask/headless`: the client of `/api/ask/**`, the answer stream over `host.sse`, the conversation, conversation-list, stream and AI-configuration hooks, and the pure error-copy, citation-parsing, model-choice and suggestion helpers. [README](src/ask/README.md).
- `@marinoscar/kvox-web/ask/ui`: `AskPage`, `AskThread`, `AskComposer`, `ConversationList`, `EntityAskPanel`, `EntityAskButton`, the slot components `AskEntityPanelSlot` and `AskEntityButtonSlot` for the graph entity page, and `kvoxAskRoutes`.
- `@marinoscar/kvox-web/brand`: the single source of the KVox look for every host: `createKvoxTheme`, `kvoxLightTheme`, `kvoxDarkTheme`, `kvoxTokens`, `kvoxLightPalette`, `kvoxDarkPalette`, `kvoxComponentOverrides`, `KVOX_BRAND`, and the inline-SVG `BrandMark` and `BrandLockup`. Needs MUI and `@marinoscar/platform-web`. [README](src/brand/README.md).
- `@marinoscar/kvox-web/shell`: the KVox app shell for every host: `KvoxAppShell` (the platform shell with the brand lockup, rail, phone bar and user menu), `createKvoxNavigation` (the slices' destinations, composed), `renderKvoxRoutes`, `defaultKvoxLinks` and `AiKeyRequired`. Needs MUI, `react-router-dom` and `@marinoscar/platform-web`. [README](src/shell/README.md).
- `@marinoscar/kvox-web/home/headless`: the first-run journey as data (`KvoxJourneyStep`, `resolveJourneySteps`, `defaultJourneySteps`), the Home sections (`KvoxHomeSection`, `KVOX_HOME_SECTIONS`) and the new-account rule (`isNewAccount`). No MUI, no router. [README](src/home/README.md).
- `@marinoscar/kvox-web/home/ui`: `KvoxHomePage`, the Home both hosts draw (greeting, counts, in progress, needs attention, waiting for review, recent transcripts and notes, knowledge, shared with me, and the first-run journey), its sections as components, `kvoxHomeDestination` and `kvoxHomeRoutes`. Host-specific blocks are slots (`heroActions`, `extraSteps`, `journeySteps`, `sections`). Needs MUI and `react-router-dom`. [README](src/home/README.md).
- The brand files, for a host's manifest, window icon and installer: `@marinoscar/kvox-web/brand/assets/mark.svg`, `@marinoscar/kvox-web/brand/assets/favicon.svg`, `@marinoscar/kvox-web/brand/assets/favicon.ico`, `@marinoscar/kvox-web/brand/assets/icon-192.png`, `@marinoscar/kvox-web/brand/assets/icon-512.png`, `@marinoscar/kvox-web/brand/assets/icon-1024.png`, `@marinoscar/kvox-web/brand/assets/icon-maskable-192.png`, `@marinoscar/kvox-web/brand/assets/icon-maskable-512.png`, `@marinoscar/kvox-web/brand/assets/badge-96.png`, `@marinoscar/kvox-web/brand/assets/apple-touch-icon-180.png` (`mark.svg` is the 512 master).
- The self-hosted Inter, with a relative `@font-face` URL: `@marinoscar/kvox-web/brand/fonts/inter.css` and `@marinoscar/kvox-web/brand/fonts/Inter-latin-variable.woff2`.
- `@marinoscar/kvox-web/copilot/headless`: `useCopilotProvider` over a `CopilotProviderPort` (status, setting, sign-in, sign-out, runtime download), `COPILOT_CONSENT_COPY` (the consent text as data), `buildCopilotCapabilities`, `hasCopilotConsent` and `copilotSignInReasonText`. No MUI. [README](src/copilot/README.md).
- `@marinoscar/kvox-web/copilot/ui`: `CopilotProviderCard`, the GitHub Copilot settings card (opt-in switch with a versioned consent dialog, runtime download, device-code or browser sign-in, model choice, capability list), and its parts `CopilotConsentBody`, `CopilotSignInDialog` and `CopilotRuntimeSection`. Built on `AccountSignInProviderCard` of `@marinoscar/platform-web/ai/ui`; makes no network call.

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
| `@mui/material` | `^9.1.0` | `core/ui`, `core/testing`, `transcription/ui`, `search/ui`, `transcripts/ui`, `notes/ui`, `graph/ui`, `ask/ui`, `home/ui`, `brand`, `copilot/ui` |
| `@mui/icons-material` | `^9.1.0` | `core/ui`, `transcription/ui`, `search/ui`, `transcripts/ui`, `notes/ui`, `graph/ui`, `ask/ui`, `home/ui` |
| `react-router-dom` | `^7.17.0` | `core/ui`, `core/testing`, `transcription/ui`, `search/ui`, `transcripts/ui`, `notes/ui`, `graph/ui`, `ask/ui`, `home/ui` |
| `@tanstack/react-virtual` | `^3.14.12` | `transcripts/ui` |
| `react-markdown` | `^10.1.0` | `notes/ui`, `ask/ui` (keep one copy: the citation plugin walks the tree it builds) |
| `remark-gfm` | `^4.0.1` | `notes/ui` |
| `@tiptap/core`, `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-table`, `@tiptap/markdown`, `@tiptap/pm` | `^3.31.3` | `notes/ui` (the visual editor, loaded lazily) |
| `sigma` | `^3.0.3` | `graph/ui` (the canvas, loaded lazily) |
| `@react-sigma/core` | `^5.0.6` | `graph/ui` (the canvas, loaded lazily) |
| `graphology` | `^0.26.0` | `graph/ui` (one copy only) |
| `graphology-layout-forceatlas2` | `^0.10.1` | `graph/ui` (the canvas, loaded lazily) |
| `@testing-library/react` | `^16.3.2` | `core/testing` |
| `@marinoscar/platform-web` | `0.1.0-next.7` (exact) | `brand` (`createKvoxTheme` builds on `createShellTheme` of `@marinoscar/platform-web/shell/headless`); `copilot/ui` (`AccountSignInProviderCard` and `aiErrorText` from `@marinoscar/platform-web/ai/ui`); no other entry |

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
- `createKvoxNavigation`, `KvoxAppShell`, `renderKvoxRoutes`, `defaultKvoxLinks` and `AiKeyRequired` (`shell`): the composition of the slices' destinations and the shell that draws them. Listed in the [shell README](src/shell/README.md).
- `KvoxHomePage` props (`heroActions`, `extraSteps`, `journeySteps`, `sections`, `tagline`, `journeyStages`, `journeyIntro`), `KvoxJourneyStep`, `kvoxHomeDestination`, `kvoxHomeDestinationRoutes` and `kvoxHomeRoutes` (`home`): the Home page and the slots a host fills. Listed in the [home README](src/home/README.md).
- `kvoxTranscriptsDestinations`, `kvoxTranscriptsDestinationRoutes` and `kvoxTranscriptsRoutes` (`transcripts/ui`), the slots of `TranscriptPage` (`TranscriptPageSlots`: `NotesSection`, `useSpeakerPeople`, `SelectionActions`, `HeaderActions`) and of the library (`TranscriptsLibrarySlots`: `SearchPrefix`), and the `sharing` (`TranscriptSharingAdapter`) and `ai` (`TranscriptAiAccess`) adapters. Each is listed in the [transcripts README](src/transcripts/README.md).
- `kvoxNotesDestinations`, `kvoxNotesDestinationRoutes`, `kvoxNotesUserSettingsSections` and `kvoxNotesRoutes` (`notes/ui`), the slots of `NotePage` (`NotePageSlots`: `Provider`, `useAsideWidth`, `HeaderActions`, `ProposalActions`, `SelectionActions`) and of the library (`NotesLibrarySlots`: `SearchPrefix`), and the `ai` (`NotesAiAccess`) adapter. Each is listed in the [notes README](src/notes/README.md).
- `kvoxReviewDestinations` and `kvoxReviewDestinationRoutes` (`graph/ui`), `kvoxAskDestinations` and `kvoxAskDestinationRoutes` (`ask/ui`), `kvoxNoteTemplatesDestinations` and `kvoxNoteTemplatesDestinationRoutes` (`notes/ui`): the Review, Ask and Templates rows for a host that lists them (Desktop); web does not spread them.
- `kvoxGraphDestinations`, `kvoxGraphDestinationRoutes`, `kvoxGraphUserSettingsSections` and `kvoxGraphRoutes` (`graph/ui`), the slot components that fill the transcript and note pages and both libraries (`graphTranscriptPageSlots` with `useGraphSpeakerPeople` and `GraphTranscriptSelectionActions`; `graphNotePageSlots` with `GraphNotePageProvider`, `useGraphNoteAsideWidth`, `GraphNoteHeaderActions`, `GraphNoteProposalActions` and `GraphNoteSelectionActions`; `graphTranscriptsLibrarySlots`, `graphNotesLibrarySlots`, `GraphSearchPrefix`), and the Ask slots of `GraphEntityPage` (`GraphEntityPageSlots`). Each is listed in the [graph README](src/graph/README.md).
- `kvoxAskRoutes` (`ask/ui`), the slot components `AskEntityButtonSlot` and `AskEntityPanelSlot` that fill `GraphEntityPageSlots.AskButton` and `AskPanel`, and the `remarkAskCitations` plugin (`ask/headless`). The ask slice adds a route under the graph slice's `knowledge` destination and no destination of its own. Each is listed in the [ask README](src/ask/README.md).

## Data

None. The browser holds no data model; it reads and writes through the API. The only browser storage is the per-tab feed cache (`sessionStorage`, `core/headless` utilities) and a scroll offset, both disposable.

## Permissions and settings

Packaged pages check no permission themselves except where a slice README says so: the app's route gate does, from the `permission` the slice's route data declares. `useHasPermission(permission)` reads the host's viewer. The transcription card and route are gated on `system_settings:read`; saving, testing and removing the key need `system_settings:write`, checked inside the page. The Search Indexing card and route declare no permission: the API gates `/api/search/index-status` and `/api/search/index` on authentication alone. The transcripts destination and the list, viewer and history routes are gated on `transcripts:read`, the new-transcript route on `transcripts:write`; the pages check `transcripts:write` and `notes:*` for their own controls. The notes destination and the library, note and history routes are gated on `notes:read`, the new-note route on `notes:write`; the Note Templates card and route declare no permission (`note_templates:*` is seeded to every role and the page's real gate is the viewer's AI key). The knowledge destination and the graph routes are gated on `graph:read` (and on the `graph` feature for the tab), import and the Knowledge graph card and route on `graph:write`. The Ask route and the Ask slot components are gated on `graph:read`, the exact string every `/api/ask/**` route enforces (there is no `ask:*` pair), and on connected knowledge being on.

## UI

### The brand subpath

`@marinoscar/kvox-web/brand` is the one definition of the KVox look; `apps/web` and KVox Desktop both consume it. It holds the colour tokens (`kvoxTokens`, both modes, plus the two brand colours of the mark), the MUI palettes and component overrides, the two assembled themes and `createKvoxTheme(mode, extend?)` (the shell's base from `createShellTheme`, with the KVox palette and component overrides on top), `KVOX_BRAND` (`productName`, `tagline`, `themeColor`, `backgroundColor`), `BrandMark` (inline SVG: no `<img>`, no network, no `public/` folder; `size`, `title`, `sx`) and `BrandLockup` (the mark and the product name as the web app bar draws them).

A host with no API and no `public/` folder gets the whole look from the entry and one CSS import:

```tsx
// Electron renderer (electron-vite) or web (Vite): the relative @font-face url makes the bundler emit the font locally.
import '@marinoscar/kvox-web/brand/fonts/inter.css';
import { ShellRoot } from '@marinoscar/platform-web/shell/ui';
import { BrandLockup, createKvoxTheme } from '@marinoscar/kvox-web/brand';

const THEMES = { light: createKvoxTheme('light'), dark: createKvoxTheme('dark') }; // module constants

export function Root() {
  return (
    <ShellRoot themes={THEMES} storageKey="theme_mode">
      <BrandLockup />
    </ShellRoot>
  );
}
```

Assets are plain package exports a bundler or a packager resolves: `@marinoscar/kvox-web/brand/assets/icon-1024.png` is the source for a Desktop `.icns` and `.ico` (`electron-builder` `icon:` path, resolved with `require.resolve` or copied from `node_modules/@marinoscar/kvox-web/dist/brand/assets/`), `.../assets/icon-512.png` the Linux and window icon, `.../assets/mark.svg` the vector master. They are not typed modules: declare `*.svg`/`*.png` for your bundler (`vite/client` does).

The Inter font is self-hosted and the `@font-face` URL is relative to `inter.css`; nothing loads from a CDN (the web CSP is `font-src 'self' data:` and Desktop forbids remote assets).

**Where the files live.** The package holds the only copy: `src/brand/assets` and `src/brand/fonts`, copied into `dist/brand` by the build (`scripts/copy-brand-assets.mjs`). The PNGs are written by `packages/kvox-web/scripts/generate-icons.py` (Python and Pillow, committed output, byte-reproducible); the SVGs are hand-written. `apps/web/public/` serves a byte-for-byte mirror (manifest, `index.html` and service worker need fixed URLs), written by `node apps/web/scripts/sync-brand-assets.mjs` and checked by `npm run brand:check -w web` and a web test.

**Identity.** `KVOX_BRAND` and the light primary come from `packages/shared/identity.json` through the committed `src/brand/identity.generated.ts`, written by `npm run brand:sync -w @marinoscar/kvox-web` (a published package cannot import the private `@app/shared`). `scripts/rename.mjs` runs the write, regenerates the icons and re-syncs the mirror; `npm run check:kvox-brand` fails CI on drift. See [RENAMING.md](../../docs/RENAMING.md).

### The home subpath

`@marinoscar/kvox-web/home/ui` is the one KVox Home; `apps/web` and KVox Desktop both render `KvoxHomePage` and bind only host facts. It reads `KvoxWebHost` (the viewer and its permissions, `features().graphEnabled`, `http`, `links`) and the summary hooks of the transcripts and notes slices, never an auth context or an API client. What a host adds is a slot: `heroActions` (before the packaged "New note"), `extraSteps` (the host's own journey steps, such as web's "Record or upload audio" or Desktop's "Import a document"), `journeySteps` (replaces the steps the slices ship), `sections` (which blocks exist; leave out `recentTranscripts` and the page never asks for a transcript summary) and `tagline`. A step needs a `permission` (the exact string the API enforces) and may need `feature: 'graph'`; a step the viewer may not take is not drawn. `createKvoxNavigation({ include: ['home', ...] })` lists the Home row first. `KvoxViewer.displayName` (optional) is the name the greeting uses. See the [home README](src/home/README.md).

```tsx
import { KvoxHomePage } from '@marinoscar/kvox-web/home/ui';

// A host without transcription: a notes-first Home with the host's own step.
<KvoxHomePage
  sections={['hero', 'journey', 'recentNotes', 'knowledge']}
  extraSteps={[importDocumentStep]}
  tagline={KVOX_BRAND.tagline}
/>;
```

### The shell subpath

`@marinoscar/kvox-web/shell` is the one KVox app shell; `apps/web` and KVox Desktop both render `KvoxAppShell` and bind only host facts. `createKvoxNavigation` composes the destinations the slices declare (Transcripts, Notes, Knowledge, and on request Review, Ask and Templates) with the host's own, `renderKvoxRoutes` turns a slice's route data into `<Route>` elements behind the platform's permission guard, `defaultKvoxLinks` is the `KvoxWebHost.links` both hosts use, and `AiKeyRequired` is the shared "add your key" state (the host passes the settings path).

```tsx
// Web (a server session): the layout route element.
<KvoxAppShell
  navigation={KVOX_NAVIGATION}
  actions={<NotificationBell />}
  banners={<MaintenanceBanner />}
  overlays={<WelcomeDialog />}
  renderUserMenuItems={(close) => <GettingStartedMenuItem onDone={close} />}
/>

// Desktop (a local single user, no API): identity and preferences are the host's.
const { navigation } = createKvoxNavigation({
  include: ['notes', 'graph', 'review', 'ask', 'templates'],
  settingsPath: '/settings',
  settingsSections: DESKTOP_SETTINGS_SECTIONS,
}); // module scope

registerSettingsFeature('graph', () => graphEnabled); // hides Knowledge, Review and Ask while off

<ShellRoot themes={THEMES} storageKey="theme_mode">
  <LocalIdentityProvider userId={connection.userId} displayName={osUserName} permissions={connection.permissions}>
    <ShellPreferencesProvider port={shellPreferencesPort}>
      <Routes>
        <Route element={<KvoxAppShell navigation={navigation} userMenuItems={DESKTOP_MENU_ITEMS} />}>
          {renderKvoxRoutes([...kvoxNotesRoutes, ...kvoxGraphRoutes, ...kvoxAskRoutes])}
        </Route>
      </Routes>
    </ShellPreferencesProvider>
  </LocalIdentityProvider>
</ShellRoot>
```

The shell reads no breakpoint and makes no request of its own. The phone bar is given the navigation without its pinned destinations (a pinned destination is a mode, never a peer on the bar; `withoutPinned`), so a host builds no second navigation. See the [shell README](src/shell/README.md).

The `core/ui` and other slice pages read the MUI theme of the host and define none themselves.

`core/ui` ships the library chrome (`LibraryPageFrame`, `FeedCountLine`, `FeedDateSeparator`, `ActiveStatusFilterChip`), `KvoxLoadingSpinner` and `KvoxCopyButton` (the shared copy control). Pages read the MUI theme of the host; the package defines none. `LibraryPageFrame` reads `down('sm')` to place its create action; that read is a page-level choice, not one of the five coupled shell breakpoint gates (`apps/web/src/__tests__/config/breakpointGates.test.ts` scans this package too).

## Infra

None. The package ships no deployment configuration and reads no environment variable.

## Observability

None. No slice logs or measures anything in the browser.

## Security notes

`MarkdownView` ignores embedded HTML (no `rehype-raw`, no rehype passthrough): the text of a note or an Ask answer is model output and untrusted. Pages never hold an API key and never call an AI provider from the browser; they call the API through the host's transport, and authorization stays in the API. The transcription page posts a provider key once and never renders a stored one (the API returns only a masked hint). The host owns the access token; a slice never sees it.

## Conformance suite

`describeKvoxWebConformance(harness, options)` from `@marinoscar/kvox-web/core/testing` registers two suites: `kvox-web.host-neutral` (a static scan of the package sources: no `@marinoscar/platform-*` import anywhere except `@marinoscar/platform-web/shell/headless` in the `brand` slice, and no headless file importing `@mui/*`, `@emotion/*`, a router or a `ui` folder) and `kvox-web.host` (the shape of a host: every port present, links that return paths, a viewer that is null or has a permission set). `packages/kvox-web/test/core/conformance.test.ts` runs both against the package and its fake host; `npm run check:kvox-slice-peers` enforces the same import rules.

## Upgrade notes

The `brand` entry and its asset and font exports are new; an app that had its own theme replaces it with `createKvoxTheme` (the web app's `src/theme/index.ts` now re-exports `kvoxLightTheme` and `kvoxDarkTheme`). This package has not been published yet (see the [release runbook](../../docs/runbooks/release-kvox-packages.md)), so there is nothing to migrate from. The `./core` entry of the scaffold (`KVOX_WEB_CORE`) is replaced by `./core/headless`, `./core/ui` and `./core/testing`.

## Troubleshooting

`KvoxHostMissingError` means a packaged page or hook rendered without a `KvoxWebHostProvider` above it. `Invalid hook call` means two copies of React: run `node scripts/kvox-packages/check-single-instance.mjs` and align the ranges. If the host context is "missing" although a provider is mounted, two copies of this package were loaded (a bundler that pre-bundled each entry separately): load them as one. `ERR_MODULE_NOT_FOUND` from Node means a relative import lost its `.js` extension. Text in the system sans instead of Inter means `@marinoscar/kvox-web/brand/fonts/inter.css` is not imported (or its `url()` was rewritten). A host that renders `BrandMark` before `@marinoscar/platform-web` is installed fails at import: `brand` needs that peer. `brand:check` failing means `identity.json` changed without `npm run brand:sync -w @marinoscar/kvox-web`.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-kvox-packages.md): versions, publishing, rollback
- [DEVELOPMENT.md](../../docs/DEVELOPMENT.md): build, test and lint commands
- [brand README](src/brand/README.md), [shell README](src/shell/README.md), [home README](src/home/README.md), [core README](src/core/README.md), [transcription README](src/transcription/README.md), [search README](src/search/README.md), [transcripts README](src/transcripts/README.md), [notes README](src/notes/README.md), [graph README](src/graph/README.md), [ask README](src/ask/README.md) and [copilot README](src/copilot/README.md): the slices

### Desktop

The renderer of KVox Desktop installs this package and provides one `KvoxWebHost` over its local server (HTTP and SSE on loopback, or IPC). The guide documents every host member and how to render the slices' routes, destinations and settings cards. See [the KVox Desktop guide](../../docs/guides/kvox-desktop.md#wiring-the-web).
