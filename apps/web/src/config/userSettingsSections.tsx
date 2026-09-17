/**
 * The per-user settings information architecture — the same registry shape as
 * `adminSections.tsx`, for the `/settings` surface.
 *
 * Issue #91, epic #90. `/settings` is today one page stacking three cards
 * (Theme, Profile, Personal Access Tokens). Epic #90 splits it into routed
 * destinations behind the same searchable hub the admin console gets (#96), so
 * it needs the same thing the console needs: ONE declaration read by the hub,
 * the AppBar's title resolver, and anything else that later wants to draw the
 * surface.
 *
 * This file deliberately declares only DATA. The `SettingsCardDef` /
 * `SettingsSectionDef` types and both helpers
 * (`visibleSettingsSections`, `settingsPageTitle`) are imported from
 * `adminSections.tsx` and re-used verbatim — which is precisely why those
 * helpers take `sections`, `hubPath` and `hubTitle` as parameters instead of
 * closing over the admin constants. Two copies of the permission gate is the
 * drift the registry exists to prevent, and copying it here to serve a second
 * surface would reintroduce it on day one.
 */

import PersonIcon from '@mui/icons-material/Person';
import PaletteIcon from '@mui/icons-material/Palette';
import NotificationsIcon from '@mui/icons-material/Notifications';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import DescriptionIcon from '@mui/icons-material/Description';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
// Getting Started (#279, epic #271) — the same icon the admin `Setup` card
// carries, on purpose: the two are the same idea on two axes (this deployment
// vs. this account), and a user who has seen one recognises the other.
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import type { SettingsSectionDef } from './adminSections';

/**
 * The user settings sections, in hub order.
 *
 * NO CARD DECLARES A `permission`, and that is the correct model rather than
 * an omission: every authenticated user owns their own settings, and the API
 * grants `user_settings:read` / `user_settings:write` to all three roles
 * (Admin, Contributor, Viewer). Adding a gate here would be inventing an
 * authorization rule the API does not enforce — the opposite of what this
 * registry is for. `visibleSettingsSections` is still the function the hub
 * calls, so search filtering and empty-section collapsing behave identically
 * to the admin surface; the permission half of the gate simply passes
 * everything through.
 *
 * Access Tokens sits under its own `Security` group rather than under
 * `Account` because a PAT is a long-lived credential: grouping it with display
 * name and theme would put "create a bearer token that outlives your session"
 * one row below "pick a colour scheme".
 */
export const USER_SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'Account',
    cards: [
      {
        // Issue #279, epic #271. FIRST IN `Account`, AND THEREFORE FIRST IN
        // THE HUB, which is the point of it: this is where the shell banner
        // (#277) leads, and — more importantly — where the checklist REMAINS
        // findable after that banner has been dismissed. A dismissal is
        // permanent by design (`onboarding.dismissedAt`, #272), so the entry
        // point it hides has to survive somewhere a user would think to look,
        // and the top of their own settings is that place.
        //
        // NO `permission`, like every other card in this registry, and here the
        // API's own shape is the argument rather than a convention this file
        // follows: `onboarding.controller.ts` gates `GET /api/onboarding` on
        // `@Auth()` with NO permission string, because the resource is the
        // caller's own activation state, scoped by `userId` in the query itself
        // — the identical posture `ai-credentials.controller.ts`,
        // `/api/user-settings` and `/api/user-data` take. A gate here would
        // invent an authorization rule the API does not enforce, and it would
        // fail in the worst direction: a Viewer — this application's DEFAULT
        // role, and therefore most of the people who ever see this page — shut
        // out of the one page explaining why AI features want a key from them.
        //
        // Under `Account` and not a group of its own: it is the same kind of
        // fact as the four cards below it (who this account is, how it is set
        // up), and a fourth group for one card would put a heading above a
        // single row at the top of the hub.
        title: 'Getting Started',
        description:
          'The few things that make this account yours: your AI provider key, your first recording, and your name.',
        Icon: RocketLaunchOutlinedIcon,
        path: '/settings/getting-started',
      },
      {
        title: 'Profile',
        description: 'Your display name and profile image, and the email you signed in with.',
        Icon: PersonIcon,
        path: '/settings/profile',
      },
      {
        title: 'Appearance',
        description: 'Choose a light, dark, or system-matched theme for this account.',
        Icon: PaletteIcon,
        path: '/settings/appearance',
      },
      {
        // Issue #126, epic #109. NO `permission`, like every card here: the
        // page edits the caller's OWN preferences through
        // `PATCH /api/user-settings`, which the API grants to all three roles,
        // and the registry it renders (`GET /api/notifications/events`) is
        // `@Auth()` with no permissions for exactly that reason — gating this
        // card would leave a Viewer unable to say how they are contacted.
        //
        // Under `Account` rather than `Security`, even though one of the events
        // it lists is a security alert: the card is about how this account is
        // contacted, not about credentials. `Security` holds long-lived
        // credentials (see the group's own note below).
        title: 'Notifications',
        description:
          'Choose which events notify you, and whether they arrive by email or in your browser.',
        Icon: NotificationsIcon,
        path: '/settings/notifications',
      },
      {
        // Issue #55, epic #45. NO `permission`, like every card here — and
        // here the reason is the strongest in the file:
        // `ai-credentials.controller.ts` gates all four of its routes on
        // `@Auth()` with NO permission, deliberately, because the resource is
        // the caller's OWN credential (scoped by `userId` in the query itself)
        // rather than a resource of this application. Declaring a gate here
        // would invent an authorization rule the API does not enforce, and
        // would leave a user unable to REMOVE their own key from a deployment
        // that had since revoked their access to the feature it was for.
        //
        // Under `Account` rather than `Security`, even though it holds a
        // credential. `Security` is for credentials THIS application issues
        // and can revoke (a personal access token). This is a third party's
        // credential, billed to the user's own provider account — it belongs
        // with the other facts about who this account is and how it is set up.
        title: 'AI Provider',
        description:
          'Connect your own AI provider key. AI features run on your account, and the usage is billed to you.',
        Icon: AutoAwesomeIcon,
        path: '/settings/ai',
      },
      {
        // Issue #191, epic #165. NO `permission`, like every card here, and
        // here the API's own shape is the argument rather than a convention
        // this file follows: `search-index.controller.ts` gates
        // `GET /api/search/index-status` and `POST /api/search/index` on
        // `@Auth()` with NO permission string, because the resource is the
        // caller's OWN content and the caller's OWN vendor account, scoped by
        // `ownerId` in the query itself — the identical posture
        // `ai-credentials.controller.ts` and `/api/user-data` take. Gating on
        // `transcripts:read` + `notes:read` was the near miss: `PermissionsGuard`
        // requires ALL declared permissions, so a user narrowed to one document
        // type would be hidden from the page reporting the state of the other.
        //
        // Under `Account`, directly after `AI Provider`, because that is the
        // order the setup actually happens in: indexing spends the key that
        // page collects, and this page's primary action is disabled with a link
        // back to it until one is saved. A PER-USER card and never an admin one
        // — the key is the user's, the content is the user's, and the bill is
        // the user's, so there is nobody else who could press this button.
        title: 'Search Indexing',
        description:
          'See what of your library can be found by meaning rather than keyword, and index the rest. Runs on your own AI provider account.',
        Icon: ManageSearchIcon,
        path: '/settings/search-index',
      },
      {
        // Issue #56, epic #45. NO `permission`, like every card here:
        // `note-templates.controller.ts` gates its routes on
        // `note_templates:read` / `note_templates:write`, both of which are
        // seeded to ALL THREE roles (Admin, Contributor, Viewer) — authoring
        // the template for your own notes is the core product action, not an
        // operational surface. Declaring a gate here would hide the card from
        // nobody while inventing a rule the API does not enforce; leaving it
        // off keeps this registry's single, consistent claim intact ("every
        // authenticated user owns their own settings"), which
        // `userSettingsSections.test.ts` asserts across the whole file.
        //
        // Under `Account` alongside `AI Provider`, not `Security`: a template
        // is a preference about how this account's notes are written. It sits
        // directly after the key it depends on — the page renders
        // `AiKeyRequired` without one — so the hub reads in the order the
        // setup actually happens.
        title: 'Note Templates',
        description:
          'Describe the notes you want from a recording, and generate a sample to check the result before you rely on it.',
        Icon: DescriptionIcon,
        path: '/settings/note-templates',
      },
    ],
  },
  {
    label: 'Security',
    cards: [
      {
        title: 'Access Tokens',
        description: 'Create and revoke personal access tokens for API and CLI access.',
        Icon: VpnKeyIcon,
        path: '/settings/tokens',
      },
    ],
  },
  {
    // Issue #80. A THIRD GROUP, LAST, AND ON ITS OWN — not a fourth card under
    // `Account` and not a second one under `Security`. The hub renders groups
    // as visually separated blocks with their own heading, and that separation
    // is the only thing this registry can contribute to safety: a destination
    // whose every action is permanent and unrecoverable must not sit one row
    // under "pick a colour scheme", which is precisely the adjacency the
    // `Security` group's own note above already objected to for a far milder
    // reason (a revocable token this application issued). Last in the array so
    // it is last on the hub and last in the Console rail, in both cases below
    // everything a user has an ordinary reason to open.
    //
    // `Security` would have been the near miss. That group is about credentials
    // — things that can be issued again after being destroyed. Nothing reached
    // from here can be: there is no undo, and no restore a user can trigger.
    //
    // NO `permission`, like every card in this registry, and here the API's own
    // shape is the argument rather than a convention this file follows:
    // `apps/api/src/user-data/`'s controller gates `GET /api/user-data/summary`
    // and `POST /api/user-data/deletions` on `@Auth()` with NO permission
    // string, because the resource is the caller's OWN data, scoped by `userId`
    // in the query itself — the identical posture `ai-credentials.controller.ts`
    // and `/api/user-settings` take. Declaring a gate here would invent an
    // authorization rule the API does not enforce, and it would fail in the
    // worst available direction: a user unable to delete data this deployment
    // is holding about them, because of a role somebody else assigned.
    label: 'Danger Zone',
    cards: [
      {
        title: 'Delete My Data',
        description:
          'Permanently delete your recordings, notes and files, or everything stored for your account.',
        Icon: DeleteForeverIcon,
        path: '/settings/danger-zone',
      },
    ],
  },
];

/**
 * The user settings hub — the one `/settings` route that owns no card.
 *
 * `USER_HUB_TITLE` is intentionally the same string as `ADMIN_HUB_TITLE`
 * ('Settings'): the two surfaces are never on screen at once, the path
 * disambiguates them for the title resolver, and calling this one "My
 * Settings" in the AppBar would be the only place in the app that names it
 * that way.
 */
export const USER_HUB_PATH = '/settings';
export const USER_HUB_TITLE = 'Settings';
