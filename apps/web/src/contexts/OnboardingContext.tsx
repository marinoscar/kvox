/**
 * Onboarding state, fetched once for the whole shell — issue #276, epic #271.
 *
 * =============================================================================
 * WHY THIS IS A PROVIDER AND NOT A HOOK EACH SURFACE CALLS
 * =============================================================================
 *
 * Four surfaces in this epic need the same answer: the shell banner (#277), the
 * admin setup page (#278), the getting-started page (#279) and the welcome
 * dialog (#280). If each fetched for itself, an administrator navigating
 * between the setup page and the pages it links to would reissue the same two
 * requests on every hop — and four components would get four chances to
 * disagree about whether setup is finished, which surfaces as a banner saying
 * "2 steps left" above a page listing three.
 *
 * Mounted ONCE, in `Layout.tsx` (#277), inside `ProtectedRoute` alongside
 * `NotificationProvider` and `UploadManagerProvider`. Not in `App.tsx` above
 * the guard: every endpoint it calls is `@Auth()`-guarded, so mounting it over
 * `/login` and `/activate` would buy a guaranteed 401 on the two routes where
 * nobody is signed in yet.
 *
 * =============================================================================
 * ⚠ THE ADMIN ROUTE IS FETCHED ONLY BEHIND `system_settings:read`
 * =============================================================================
 *
 * `GET /api/admin/onboarding` is `system_settings:read`, and this provider
 * lives in the shell of EVERY signed-in user — most of whom are Viewers,
 * because Viewer is this application's default role. Firing it for them would
 * buy one predictable 403 per session, on every deployment, forever, for an
 * answer they could not read.
 *
 * The gate is a BOOLEAN PASSED INTO ONE `useCallback`, never a conditional hook
 * call and never an early return that skips a hook — the number and order of
 * hooks here does not depend on the permission set, so a user whose session
 * resolves after the first render cannot change this component's hook order.
 * `MaintenanceBanner` makes the same call for the same reason, through
 * `useMaintenance({ enabled })`.
 *
 * =============================================================================
 * ⚠ NO POLLING. NO INTERVAL. NO TIMER OF ANY KIND. EVER.
 * =============================================================================
 *
 * Fetched once on mount, and re-fetched only on an explicit {@link
 * OnboardingContextValue.refresh} — which the two pages call when they mount,
 * and the return-to-setup bar (#280) calls when the user comes back from a
 * destination they were sent to.
 *
 * Onboarding state changes when the USER DOES SOMETHING, and the user is
 * standing right there when they do it. A background poll would run on every
 * page of the shell for the lifetime of a tab that is, by construction, the tab
 * most likely to be left open all day — and it would buy nothing that a
 * `refresh()` on the surface that cares does not already buy. The one case that
 * looks like it needs a poll (an administrator finishing transcription setup in
 * a second tab) is exactly that case: the tab they come back to remounts the
 * page, and the page refreshes.
 *
 * `useVisiblePolling` exists in this codebase and is deliberately NOT used
 * here. If a later change adds one, `__tests__/contexts/OnboardingContext.test.tsx`
 * greps this file's source for the timer APIs and fails.
 *
 * =============================================================================
 * A FAILED FETCH RENDERS NOTHING — IT NEVER RENDERS AN ERROR
 * =============================================================================
 *
 * `user` and `admin` stay `null` when a read fails, and every consumer treats
 * `null` as "render nothing". `error` is exposed for a page that wants to say
 * something in its own body, but the SHELL surfaces must not: an error banner
 * raised from a provider mounted in `Layout` appears on every page of the
 * application at once, and the failure it is reporting — an optional checklist
 * did not load — is not worth that. `useAiConfig` takes the same position, and
 * clears its config on a failed refresh for the same reason: a surface must not
 * keep rendering an answer from ten minutes ago.
 *
 * The two reads are `Promise.allSettled`, not `Promise.all`: an administrator
 * whose deployment checklist 500s should still see their own, and a single
 * `await Promise.all` would discard both.
 *
 * ⚠ A MALFORMED 200 IS A FAILED READ, and it is `services/onboarding.ts` that
 * makes it one. That promise above was kept for REJECTIONS and broken for
 * successes carrying the wrong body: a 200 of `{}` is truthy, so it was stored,
 * memoised and handed to `applySkipOverlay`, which reached `state.steps.map`
 * and threw inside this provider's render — and because `Layout.tsx` mounts
 * this provider in the SHELL, React unwound the whole application into
 * `ErrorBoundary`. The narrowing at the service boundary turns that body into a
 * rejection, which is a path this file already handles: state `null`, `error`
 * set, consumers render nothing. Nothing in this file had to learn a third
 * state, which is the argument for validating there rather than here.
 *
 * =============================================================================
 * WRITES: ONE `PATCH /api/user-settings` EACH, THROUGH THE EXISTING HOOK
 * =============================================================================
 *
 * `dismiss`, `skip`, `unskip` and `markWelcomeSeen` are one PATCH each, into the
 * `onboarding` namespace (#272), through `useUserSettings` — which already
 * carries the `If-Match` optimistic concurrency header and its own 409 refetch.
 * There is NO onboarding write endpoint and no second PATCH path here, and
 * adding either would mean two implementations of version handling, one of them
 * eventually wrong.
 *
 * ⚠ ON A 409 THIS FILE DOES NOT RETRY IN THE SAME TICK, and that is structural
 * rather than an omission. `updateSettings` is a `useCallback` closed over the
 * `settings` it was built with; its 409 branch refetches and throws, but the
 * closure this file is holding still carries the STALE version, so an immediate
 * second call would send the same stale `If-Match` and 409 again. The refetch
 * inside the hook is what resolves the conflict, the optimistic overlay is
 * reverted, and the next interaction writes against the fresh version. Writing
 * a retry loop here would require reading the version from somewhere other than
 * the hook, which is the second PATCH path this paragraph exists to forbid.
 *
 * The overlay itself follows `useNavigationPrefs` exactly: apply locally, clear
 * on settle, so the revert is the same code path as the commit and there is no
 * separate error branch to rot.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useIsMounted } from '../hooks/useIsMounted';
import { usePermissions } from '../hooks/usePermissions';
import { useUserSettings } from '../hooks/useUserSettings';
import { ApiError } from '../services/api';
import {
  getAdminOnboardingState,
  getOnboardingState,
  type OnboardingAudience,
  type OnboardingState,
} from '../services/onboarding';
import type { OnboardingSettings } from '../types';

/**
 * The permission `GET /api/admin/onboarding` enforces, spelled once.
 *
 * ⚠ THE EXACT STRING `admin-onboarding.controller.ts` DECLARES — #275 reuses
 * `system_settings:read` rather than inventing `onboarding:read`, following
 * epic #118 decision 8's precedent for the About card. This is the same
 * discipline CLAUDE.md's Settings UI Pattern rule 3 imposes on a registry
 * card's `permission` field: never invented, never approximated.
 */
export const ONBOARDING_ADMIN_PERMISSION = 'system_settings:read';

export interface OnboardingContextValue {
  /** The caller's own activation checklist, or `null` while loading or after a failed read. */
  user: OnboardingState | null;
  /**
   * This deployment's setup checklist.
   *
   * `null` when the caller lacks `system_settings:read` — in which case it was
   * never requested — and equally `null` when the request failed. The two are
   * deliberately indistinguishable to a consumer, because a consumer's
   * behaviour is the same either way: render nothing.
   */
  admin: OnboardingState | null;
  /** True until the first read settles, including the user-settings read the writes need. */
  isLoading: boolean;
  /**
   * What went wrong, for a PAGE to render in its own body.
   *
   * ⚠ Never rendered by a shell surface. See the file header.
   */
  error: string | null;
  /** Re-read both checklists. The only thing that ever refetches; there is no timer. */
  refresh: () => Promise<void>;
  /** Record that this user put one of the two checklist surfaces away. */
  dismiss: (audience: OnboardingAudience) => Promise<void>;
  /** Record that this user chose not to do a step. Never available for a `required` one. */
  skip: (stepKey: string) => Promise<void>;
  /** Undo a skip. The reason #275 returns skipped steps instead of filtering them out. */
  unskip: (stepKey: string) => Promise<void>;
  /** Record that the welcome dialog (#280) has been shown. */
  markWelcomeSeen: () => Promise<void>;
  /** Has this user seen the welcome dialog? Absent timestamp ⇒ `false` ⇒ never. */
  welcomeSeen: boolean;
  /** Has this user put each surface away? Absent timestamp ⇒ `false` ⇒ still due. */
  dismissed: { user: boolean; admin: boolean };
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * Re-mark a fetched checklist against a skip list the server has not seen yet.
 *
 * ⚠ THIS IS AN OPTIMISTIC OVERLAY, NOT A SECOND DERIVATION OF TRUTH, and the
 * distinction is the whole reason it is allowed to exist next to #275's
 * decision to compute the counts server-side. Between the click that skips a
 * step and the `refresh()` that re-reads the checklist, the server's `steps[]`
 * still says `skipped: false` for that key and its counts still include it — so
 * without this the row would not visibly move for a whole round trip, and the
 * progress bar would lag behind the list the user is looking at.
 *
 * The recount is EXACTLY the rule the DTO documents ("neither satisfied nor
 * skipped"), restated here and nowhere else. It is discarded on the next read:
 * the server's own numbers win the moment they arrive, which is what keeps this
 * from becoming the competing derivation #275 rejected.
 *
 * Returns the SAME OBJECT when nothing changes — which is the ordinary case,
 * since with no write in flight the effective skip list is the one the server
 * already read. That keeps the context value's identity stable across renders
 * rather than handing every consumer a fresh object on every tick.
 *
 * ⚠ THE GUARD CHECKS `steps` AND NOT MERELY TRUTHINESS, and that is belt to
 * `services/onboarding.ts`'s braces rather than the fix itself. `{}` is truthy,
 * so `if (!state)` alone let a malformed 200 reach `state.steps.map(...)` — and
 * because this function runs inside `OnboardingProvider`'s own `useMemo`, the
 * `TypeError` was thrown DURING THE SHELL'S RENDER and React unwound the entire
 * application into `ErrorBoundary`'s "Something went wrong" panel, on every
 * page. The service now rejects such a body before it is ever stored, so this
 * line should be unreachable; it stays because the cost of being wrong about
 * that is the whole application, and the cost of the check is one `Array.isArray`.
 */
export function applySkipOverlay(
  state: OnboardingState | null,
  skippedKeys: readonly string[],
): OnboardingState | null {
  if (!state || !Array.isArray(state.steps)) return null;

  const skipped = new Set(skippedKeys);
  let changed = false;

  const steps = state.steps.map((step) => {
    const next = skipped.has(step.key);
    if (next === step.skipped) return step;
    changed = true;
    return { ...step, skipped: next };
  });

  if (!changed) return state;

  const remaining = steps.filter((step) => step.status !== 'satisfied' && !step.skipped);
  const requiredRemaining = remaining.filter((step) => step.tier === 'required').length;

  return {
    ...state,
    steps,
    requiredRemaining,
    totalRemaining: remaining.length,
    allRequiredSatisfied: requiredRemaining === 0,
  };
}

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  return fallback;
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { hasPermission } = usePermissions();
  // Read once per render into a plain boolean. The FETCH decision is this
  // value, handed to `refresh` as an ordinary dependency — never an `if` around
  // a hook, and never an early `return` above one.
  const canReadAdmin = hasPermission(ONBOARDING_ADMIN_PERMISSION);

  // `syncTheme: false`, for the reason the option exists: this provider is
  // mounted by the ALWAYS-PRESENT app shell and is here for the `onboarding`
  // namespace only. Left on, it would quietly make the STORED theme
  // authoritative on every page load and stamp over the AppBar's own light/dark
  // toggle on the next navigation. `useNavigationPrefs` opts out identically.
  const {
    settings,
    isLoading: isLoadingSettings,
    updateSettings,
  } = useUserSettings({ syncTheme: false });

  const isMounted = useIsMounted();

  const [user, setUser] = useState<OnboardingState | null>(null);
  const [admin, setAdmin] = useState<OnboardingState | null>(null);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (isMounted()) {
      setIsFetching(true);
      setError(null);
    }

    // `allSettled`, not `all`: an administrator whose DEPLOYMENT checklist
    // fails should still be shown their own, and `Promise.all` would reject on
    // the first failure and discard the other answer with it.
    //
    // The second entry is a resolved `null` rather than a request when the
    // caller cannot read it. Nothing is sent; there is no 403 to swallow.
    const [userResult, adminResult] = await Promise.allSettled([
      getOnboardingState(),
      canReadAdmin ? getAdminOnboardingState() : Promise.resolve(null),
    ]);

    if (!isMounted()) return;

    // Cleared rather than left stale on a failure, `useAiConfig`'s position: a
    // surface must not keep offering a checklist read before the deployment
    // changed under it.
    setUser(userResult.status === 'fulfilled' ? userResult.value : null);
    setAdmin(adminResult.status === 'fulfilled' ? adminResult.value : null);

    const failure =
      userResult.status === 'rejected'
        ? userResult.reason
        : adminResult.status === 'rejected'
          ? adminResult.reason
          : null;
    setError(failure ? messageFor(failure, 'Failed to load setup state') : null);

    setIsFetching(false);
  }, [canReadAdmin, isMounted]);

  // The ONE automatic read. `refresh` changes identity only when the admin gate
  // flips (a session resolving from "loading" into an administrator), which is
  // the one case where a second read is the correct behaviour rather than a
  // poll — the first read could not have asked for the admin checklist.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---------------------------------------------------------------------------
  // Writes — one PATCH each, `onboarding` namespace only, optimistic overlay
  // ---------------------------------------------------------------------------

  const [overlay, setOverlay] = useState<OnboardingSettings | null>(null);
  // Guards a late response from an EARLIER write clearing a NEWER overlay: two
  // quick clicks race, and without the sequence check the first response to land
  // would drop the second click's optimistic state back to what is stored.
  const writeSeq = useRef(0);

  const stored = settings?.onboarding;

  /**
   * What the UI should behave as though is stored: the server's namespace with
   * any in-flight change laid over it.
   *
   * Field-wise, matching the API's own merge semantics for this namespace, with
   * `skipped` replaced wholesale — which is also how the server treats it, so
   * the overlay and the write agree by construction.
   */
  const effective = useMemo<OnboardingSettings>(
    () => ({ ...(stored ?? {}), ...(overlay ?? {}) }),
    [stored, overlay],
  );

  const skippedKeys = useMemo(() => effective.skipped ?? [], [effective.skipped]);

  const write = useCallback(
    async (change: OnboardingSettings) => {
      // No settings yet means no `version` for the `If-Match` header, so
      // `updateSettings` would no-op. Skipping the overlay too keeps the UI
      // honest rather than showing a change that was never sent —
      // `useNavigationPrefs` takes the same position for the same reason.
      if (!settings) return;

      const seq = ++writeSeq.current;
      setOverlay((current) => ({ ...(current ?? {}), ...change }));

      try {
        // Only the `onboarding` namespace, and inside it only the field that
        // changed: PATCH merges field-wise server-side, so a concurrent change
        // to another field (or another namespace) is preserved rather than
        // clobbered. This is the ONE write path in this epic.
        await updateSettings({ onboarding: change });
      } catch {
        // Swallowed on purpose. The revert below is the whole error handling:
        // clearing the overlay falls back to what is stored, which on a failure
        // is still the old value — the same code path as a success, with no
        // separate error branch to rot. A rejection escaping here would also
        // become an unhandled rejection in a click handler that has nothing
        // useful to do with it.
      } finally {
        if (isMounted() && writeSeq.current === seq) setOverlay(null);
      }
    },
    [settings, updateSettings, isMounted],
  );

  const dismiss = useCallback(
    async (audience: OnboardingAudience) => {
      // TWO TIMESTAMPS, NOT ONE FLAG (#272). An administrator is also a user,
      // and the two surfaces say different things — putting the deployment
      // banner away must not also put their own getting-started checklist away.
      const now = new Date().toISOString();
      await write(audience === 'admin' ? { adminDismissedAt: now } : { dismissedAt: now });
    },
    [write],
  );

  const skip = useCallback(
    async (stepKey: string) => {
      // No-op when the key is already skipped: the PATCH would be a version
      // bump that changes nothing, and a double-click should not cost two.
      if (skippedKeys.includes(stepKey)) return;
      await write({ skipped: [...skippedKeys, stepKey] });
    },
    [skippedKeys, write],
  );

  const unskip = useCallback(
    async (stepKey: string) => {
      if (!skippedKeys.includes(stepKey)) return;
      await write({ skipped: skippedKeys.filter((key) => key !== stepKey) });
    },
    [skippedKeys, write],
  );

  const markWelcomeSeen = useCallback(async () => {
    // A timestamp rather than a boolean, so the record can still answer "when",
    // which a boolean throws away irrecoverably. Written once; re-writing it on
    // every dialog open would lose the first-run instant it exists to record.
    if (effective.welcomeSeenAt) return;
    await write({ welcomeSeenAt: new Date().toISOString() });
  }, [effective.welcomeSeenAt, write]);

  const userView = useMemo(() => applySkipOverlay(user, skippedKeys), [user, skippedKeys]);
  const adminView = useMemo(() => applySkipOverlay(admin, skippedKeys), [admin, skippedKeys]);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      user: userView,
      admin: adminView,
      // The settings read counts: every consumer that renders a checklist also
      // branches on whether it was dismissed, and a banner that flashes into
      // view for one frame before a stored dismissal arrives is worse than one
      // that appears a beat late.
      isLoading: isFetching || isLoadingSettings,
      error,
      refresh,
      dismiss,
      skip,
      unskip,
      markWelcomeSeen,
      // `Boolean(...)`, never a truthiness check on the raw field, because
      // ABSENCE IS THE SIGNAL here (#272) and the value is a string that a
      // consumer must not accidentally render.
      welcomeSeen: Boolean(effective.welcomeSeenAt),
      dismissed: {
        user: Boolean(effective.dismissedAt),
        admin: Boolean(effective.adminDismissedAt),
      },
    }),
    [
      userView,
      adminView,
      isFetching,
      isLoadingSettings,
      error,
      refresh,
      dismiss,
      skip,
      unskip,
      markWelcomeSeen,
      effective.welcomeSeenAt,
      effective.dismissedAt,
      effective.adminDismissedAt,
    ],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

/**
 * The onboarding state, or `null` where no provider is mounted.
 *
 * DOES NOT THROW ON A MISSING PROVIDER, unlike `useAuth`, and the difference is
 * deliberate — `useNotifications` made the same call for the same reason. The
 * consumers are shell chrome and two ordinary pages; a shell that refuses to
 * render because an OPTIONAL data provider is absent turns a missing checklist
 * into a blank application. Several test files also render these surfaces on
 * their own, and none of them is about onboarding.
 *
 * The cost is that a wiring mistake hides the checklist silently instead of
 * failing loudly, so the coverage that matters is a POSITIVE assertion — with
 * the provider mounted, the surface is present — rather than reliance on a
 * crash.
 */
export function useOnboarding(): OnboardingContextValue | null {
  return useContext(OnboardingContext);
}

export { OnboardingContext };
