// =============================================================================
// Data a slice exports so the app can spread it into its own registries
// =============================================================================
//
// A slice never owns a registry. It exports its settings cards, destinations
// and routes as plain DATA with these types, and the app spreads them where its
// literal entries used to be, in the same order, so the settings hub, the
// Console rail and the AppBar title resolver see exactly what they saw before.
// The types are structurally the app's own (`SettingsCardDef`,
// `ShellDestination`), so a spread needs no cast.
// =============================================================================

import type { SvgIconComponent } from '@mui/icons-material';
import type { ComponentType, LazyExoticComponent } from 'react';

/**
 * One settings card a slice contributes to a settings hub (the admin Console or
 * the per-user settings).
 *
 * @remarks
 * Structurally the app's `SettingsCardDef`. `permission` is the EXACT string the
 * API controller enforces, never invented or approximated. The card carries no
 * component: the hub draws it, and the route in {@link KvoxRouteDef} renders the
 * page.
 *
 * `F` is the union of settings-feature keys the card may name (`'graph'`). It
 * defaults to `never`, which is right for a card that is never feature-gated; a
 * slice with a gated card writes `KvoxSettingsCard<'graph'>`.
 *
 * @stability experimental
 * @extensionPoint settings-card
 */
export interface KvoxSettingsCard<F extends string = never> {
  /** The card title, also the page's title in the AppBar. */
  title: string;
  /** One sentence under the title. */
  description: string;
  /** The icon COMPONENT (never an element): the hub and the rail draw it at different sizes. */
  Icon: SvgIconComponent;
  /** The route the card opens. */
  path: string;
  /** The permission (or any of several) the viewer needs to see the card. */
  permission?: string | readonly string[];
  /** Show the card but not as a link. */
  disabled?: boolean;
  /** Show the card even when the viewer lacks the permission. */
  alwaysShow?: boolean;
  /** A settings feature that must be on for the card to be visible. */
  feature?: F;
}

/**
 * The props a destination icon is drawn with.
 *
 * @stability experimental
 */
export interface KvoxIconProps {
  /** MUI's icon size keyword. */
  fontSize?: 'inherit' | 'large' | 'medium' | 'small';
}

/**
 * One navigation destination (a rail row, a bottom-bar tab) a slice contributes.
 *
 * @remarks
 * Structurally the app's `ShellDestination`. The prefixes a destination owns
 * (what makes its row light up) are the `Record<key, readonly string[]>` the app
 * keeps next to its destinations, and a slice exports them as
 * {@link KvoxDestinationRoutes}.
 *
 * @stability experimental
 * @extensionPoint destination
 */
export interface KvoxDestination<K extends string = string, F extends string = never> {
  /** The stable key of the destination. */
  key: K;
  /** The label of the rail and the user menu. */
  label: string;
  /** The label under the icon of the collapsed rail and the bottom bar. */
  compactLabel: string;
  /** The icon COMPONENT. */
  Icon: ComponentType<KvoxIconProps>;
  /** Where the row navigates. */
  path: string;
  /** The permission the viewer needs. */
  permission?: string;
  /** Any one of these permissions suffices. */
  anyPermission?: readonly string[];
  /** Pinned destinations are modes (Settings, Console), not bottom-bar tabs. */
  pinned?: boolean;
  /** A settings feature that must be on. */
  feature?: F;
  /** Rail group heading. */
  group?: string;
}

/**
 * The route prefixes each destination owns, keyed by destination key.
 *
 * @stability experimental
 */
export type KvoxDestinationRoutes<K extends string = string> = Readonly<Record<K, readonly string[]>>;

/**
 * One route a slice contributes. The app wraps it in its own guard and layout.
 *
 * @remarks
 * `permission` is the exact string the route is gated on; the app renders its
 * own `RequirePermission` around `Component` when it is set. The component is
 * lazy so importing a slice's route data pulls no page into the main chunk.
 *
 * @stability experimental
 * @extensionPoint route
 */
export interface KvoxRouteDef {
  /** The route path, for example `/admin/settings/transcription`. */
  path: string;
  /** The permission the route is gated on, when it is gated. */
  permission?: string;
  /**
   * Where a viewer without `permission` is sent. Defaults to `/` (home); a
   * route that is only the creating half of a list (`/transcripts/new`) sends
   * the viewer back to the list.
   */
  redirectTo?: string;
  /** The page, lazily loaded. */
  Component: LazyExoticComponent<ComponentType> | ComponentType;
}
