# home

The KVox Home page, once: the greeting, the counts, what is moving, what failed, what is waiting for review, the recent transcripts and notes, the knowledge, what others shared, and the first-run journey for an account with nothing yet.

## Purpose and scope

KVox web and KVox Desktop show the same first-run experience by rendering this slice instead of copying it (ADR-0001, packages first). Home used to be app code (`apps/web/src/pages/HomePage.tsx` and `components/home/*`) because it read the web app's auth context and a few web-only calls; Desktop opened on a bare Notes list with a generic empty state. The page now reads only `KvoxWebHost` (the viewer and its permissions, the `graph` switch, `http`, `links`) and the hooks of the transcripts, notes and graph slices. It imports no `@marinoscar/platform-*` package (rule `host-neutral`), makes no request of its own beyond those slices' summaries, and reads no breakpoint (the five coupled gates stay five).

What differs between hosts is a slot, not a fork: the host's own actions in the hero (`heroActions`), the host's own journey steps (`extraSteps`; web: "Record or upload audio", Desktop: "Import a document"), the steps the slices ship (`journeySteps`) and which blocks exist (`sections`). The page is given nothing about transcription, so a host without it asks for no transcript summary at all.

Status: filled (issue #632, epic marinoscar/kvox-desktop#26).

## Entry point

- `@marinoscar/kvox-web/home/headless`: `resolveJourneySteps`, `defaultJourneySteps`, `isJourneyStepVisible`, `isNewAccount`, `KVOX_HOME_SECTIONS` and the types `KvoxJourneyStep`, `KvoxJourneyStepAction`, `KvoxJourneyContext`, `KvoxJourneyProgress`, `ResolveJourneyStepsOptions`, `KvoxHomeSection`, `NewAccountFacts`. No MUI, no router.
- `@marinoscar/kvox-web/home/ui`: `KvoxHomePage` (and `KvoxHomePageProps`), `kvoxHomeDestination`, `kvoxHomeDestinationRoutes`, `kvoxHomeRoutes`, and the sections as components (`HomeHero`, `CountsStrip`, `InProgressSection`, `NeedsAttention`, `GraphReviewCard`, `RecentTranscripts`, `RecentNotes`, `KnowledgeSection`, `SharedWithMe`, `JourneyEmptyState`, `HomeSkeleton`, `HomeSearchField`, `NoteSummaryCard`, `TranscriptSummaryCard`) with their pure helpers (`countsEntries`, `firstNameOf`, `searchPathFor`, `dedupeServerItems`, `accessRoleLabel`).

## Peer dependencies

`headless`: `react`. `ui`: `@mui/material`, `@mui/icons-material`, `react-router-dom` and `react`, plus what the `transcripts`, `notes` and `graph` `ui` entries need (the page mounts their status chips and the review sheet). Needs a `KvoxWebHostProvider` and a router above it, and the `KvoxUploadManagerProvider` of `transcripts/headless` (mounted once at the app root) unless the host leaves `recentTranscripts` out of `sections`: the in-progress block lists the uploads running in this tab through it.

## Configuration

None at runtime. `KvoxViewer.displayName` (optional) is the name the greeting uses; without it Home says "Hi there".

## Extension-point catalog

- `KvoxHomePage` props: `heroActions` (before the packaged "New note"), `extraSteps` (after the others, in order), `journeySteps` (replaces the slices' own; `[]` for none), `sections` (default every section; the page keeps its order), `tagline` (not drawn without it; web passes `TAGLINE`, a brand host `KVOX_BRAND.tagline`), `journeyStages` and `journeyIntro` (default: the web copy, so every host shows the same empty state).
- `KvoxJourneyStep`: `key`, `title` (labels the step for assistive technology), `body` (a sentence, or the reason the action is unavailable with a link to fix it), `done`, `action` (`label`, `to` or `onClick`, `disabled`, `icon`, `describedBy`), `permission` (the exact string the API enforces) and `feature` (`'graph'`). A step the viewer may not take, or whose feature is off, is not drawn.
- `KvoxHomeSection`: `hero`, `journey`, `counts`, `inProgress`, `needsAttention`, `recentTranscripts`, `recentNotes`, `knowledge`, `sharedWithMe`. Listing `recentTranscripts` is what makes the page read the transcript summary; without it the counts strip (which is transcript-led) and the transcript halves of the other sections stay empty.
- `kvoxHomeDestination`, `kvoxHomeDestinationRoutes` and `kvoxHomeRoutes`: the Home row (`include: ['home']` of `createKvoxNavigation`, listed first) and its `/` route. A host that fills a slot mounts `KvoxHomePage` itself in a `<Route path="/">` instead of spreading `kvoxHomeRoutes`.

### Hosts

Web (`apps/web/src/pages/HomePage.tsx`): probes `GET /api/transcription/config`, passes its "New transcript" button as `heroActions`, the "Record or upload audio" step as `extraSteps` with `journeySteps={[]}`, and `tagline={TAGLINE}`.

Desktop (a later issue): `<KvoxHomePage sections={['hero', 'journey', 'recentNotes', 'knowledge']} extraSteps={[importStep]} tagline={KVOX_BRAND.tagline} />` over its local host; the slices' own steps (write a note, explore the knowledge) are the default journey.

### Testing

`packages/kvox-web/test/home/` renders the page over `createFakeKvoxWebHost` with no API: step filtering and ordering, the slots, the sections, the new-account rule and a host without transcripts. The web edition's suites (`apps/web/src/__tests__/pages/HomePage.test.tsx` and `components/home/`) render the same components over MSW and the real hooks.
