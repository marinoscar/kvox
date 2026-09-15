/**
 * The top of the signed-in home page — issue #32, epic #19; a second action
 * since issue #173 and a search entry point since issue #172, both epic #166.
 *
 * Four things, in the order a phone screen can afford them: who this is, what
 * the product is for, the actions that start the flow, and the way back to
 * something already in here.
 *
 * =============================================================================
 * WHY THE GREETING CARRIES NO TIME OF DAY
 * =============================================================================
 *
 * "Good morning" is the obvious thing to write here and it is wrong twice
 * over. It is non-deterministic — the pixel baselines under
 * `tests/visual/specs/` run at `maxDiffPixels: 4`, so a greeting that changes
 * at 12:00 re-baselines itself twice a day — and it is computed from the
 * BROWSER's clock, which is routinely wrong (the same clock-skew reality
 * `utils/relativeTime.ts` guards against by hand). A greeting that says "Good
 * evening" at breakfast reads as a bug in the app rather than as a wrong clock
 * on the machine.
 *
 * =============================================================================
 * THE TAGLINE IS READ, NEVER WRITTEN
 * =============================================================================
 *
 * `TAGLINE` comes from `@app/shared`, which reads
 * `packages/shared/identity.json`. This is a TEMPLATE repository: a fork
 * renames the product and rewrites its promise in one file, and a component
 * holding its own copy of either would quietly keep the old one — the exact
 * failure `apps/cli/src/template-identity.test.ts` exists to catch for the
 * product name. There is no second spelling of this sentence anywhere in the
 * web app, and there must not be one.
 *
 * =============================================================================
 * TWO ACTIONS, AND ONLY ONE OF THEM IS PRIMARY (#173)
 * =============================================================================
 *
 * Until issue #173 this hero offered exactly one way in — New transcript — and
 * "New note" appeared ONLY inside `RecentNotes`' `total === 0` zero-state. That
 * made generating a note something a user could do exactly once from the
 * landing screen: their second note had no entry point here at all, even though
 * a note generated from an uploaded document or from another note needs no
 * recording and is a first-class way into the product.
 *
 * NEW TRANSCRIPT STAYS `contained`, NEW NOTE IS `outlined`. Two filled buttons
 * side by side is a hero with no obvious first move, which is the one thing
 * this block exists to provide. Capture is still the front of the
 * Capture → Correct → Transform flow `VISION.md` describes, so it keeps the
 * emphasis; Transform sits beside it as the alternative, not as its equal.
 *
 * ⚠ THE NOTE ACTION IS GATED ON A PROP, NOT ON A HOOK READ IN HERE. This
 * component is presentational and stays that way: `HomePage` already calls
 * `usePermissions()` and already computes `canWriteNotes` for `RecentNotes`, so
 * a second `usePermissions()` here would be a second place for the page and its
 * hero to disagree about the same user. `canCreateNote` defaults to `false`
 * rather than `true` — a caller that forgets the prop must lose an action, never
 * manufacture one the user may not be allowed to take.
 *
 * `notes:write` is the string, because it is the string
 * `apps/api/src/notes/notes.controller.ts` enforces on `POST /api/notes` and the
 * one `App.tsx` guards `/notes/new` with — the same Settings-UI-Pattern rule 3
 * discipline the admin cards and `config/destinations.ts` follow.
 *
 * NO CAPABILITY PROBE FOR THE NOTE ACTION, DELIBERATELY. `NewTranscriptButton`
 * is disabled by `GET /api/transcription/config` because a deployment with no
 * provider answers 409 to `POST /api/transcripts`, and walking a user through
 * picking a file before refusing is worse than a disabled button. The note
 * equivalent would be `GET /api/ai/config` — but that is a THIRD request on the
 * landing screen, and the answer it returns is about the USER's own AI key,
 * which `/notes/new` asks for and explains in place far better than a greyed-out
 * button on the home page can. This action therefore costs no network request
 * at all, which keeps `HomePage`'s "one request per content type, plus one
 * capability probe" rule exactly as it was.
 *
 * `RecentNotes`' OWN ZERO-STATE BUTTON IS UNCHANGED and is not redundant with
 * this one. It sits in a card that explains what a note is to the one account
 * that has never generated one, next to the transcripts it would be generated
 * from; removing it as a duplicate would take the New-note action away from
 * precisely the user who needs the explanation attached to it.
 *
 * =============================================================================
 * AND A WAY TO FIND SOMETHING ALREADY IN HERE (#172)
 * =============================================================================
 *
 * `HomeSearchField` sits BELOW the action pair, not above it, and that is a
 * decision about a 390px phone rather than a default. The hero already stacks a
 * greeting, a tagline and two full-width buttons; from `sm` up the greeting and
 * the actions are a single ROW, so "under the greeting, above the actions"
 * is not even expressible there without collapsing that row back into a column
 * and undoing #173's layout. Below the pair the field is one honest full-bleed
 * row on a phone and a capped control under the greeting column on a desktop,
 * in both cases read in the order `VISION.md` states the flow: capture
 * (New transcript), transform (New note), **find it again later** (search).
 *
 * Putting it first was considered and rejected for the same reason #173 made
 * New note `outlined`: this hero must have ONE obvious first move, and pushing
 * the primary action down a phone screen behind a control for content the user
 * may not have yet is the surest way to lose it. A brand-new account has
 * nothing to search FOR, and it is that account the hero's ordering is for.
 *
 * WHY THE FIELD IS ITS OWN COMPONENT rather than twenty lines inline here: it
 * owns a controlled input, so every keystroke re-renders its owner — and its
 * owner, inline, would be this hero, re-rendering `NewTranscriptButton` and its
 * permission reads on every character typed. It also carries the whole
 * navigate-versus-dropdown, `/transcripts?q=`-versus-`/search` argument in its
 * own header, which is where the next person to touch search will look for it.
 *
 * =============================================================================
 * NO BREAKPOINT GATE LIVES HERE EITHER
 * =============================================================================
 *
 * The pair stacks full width on phones and sits inline from `sm` up, and that
 * is a `Stack direction={{ xs, sm }}` plus `sx` width objects resolved in CSS —
 * never a `useMediaQuery`. `HomePage`'s header states the rule for this whole
 * subtree: a JavaScript breakpoint read here would be a sixth gate to check
 * every time one of the five `docs/specs/settings-ui.md` §5 pins together moves,
 * in exchange for a layout CSS already does.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import { useNavigate } from 'react-router-dom';
import { TAGLINE } from '@app/shared';

import { HomeSearchField } from './HomeSearchField';
import { NewTranscriptButton } from './NewTranscriptButton';

export interface HomeHeroProps {
  /** The signed-in user's effective display name, or null when they have none. */
  displayName: string | null;
  /** `GET /api/transcription/config` said this deployment can transcribe. */
  transcriptionAvailable: boolean;
  /** The capability probe has not answered yet. */
  isCheckingTranscription?: boolean;
  /**
   * The caller holds `notes:write` — the exact string `notes.controller.ts`
   * enforces on `POST /api/notes` and `App.tsx` guards `/notes/new` with.
   *
   * Absent means NO. See the header: a forgotten prop must cost an action, not
   * advertise one the API would refuse and the router would bounce.
   */
  canCreateNote?: boolean;
}

/**
 * The first word of a display name, for a greeting.
 *
 * Exported because the page's test asserts the rule rather than one example of
 * it, and because "the bit before the first space" is a decision (as opposed to
 * "the bit before the first comma", which is what a `Surname, Given` directory
 * export would need) that deserves to be stated once.
 *
 * Returns `null` — never an empty string — for a name that is absent, blank, or
 * pure whitespace, so the caller renders the nameless greeting rather than
 * "Hi, " with a dangling comma.
 */
export function firstNameOf(displayName: string | null | undefined): string | null {
  if (!displayName) return null;
  const first = displayName.trim().split(/\s+/)[0];
  return first ? first : null;
}

export function HomeHero({
  displayName,
  transcriptionAvailable,
  isCheckingTranscription = false,
  canCreateNote = false,
}: HomeHeroProps) {
  const navigate = useNavigate();
  const firstName = firstNameOf(displayName);

  return (
    <Box component="section" aria-labelledby="home-greeting" sx={{ mb: { xs: 3, sm: 4 } }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{
          // `flex-start` rather than `center` at `sm`+: the left column is two
          // lines tall and the button is one, and centring the pair puts the
          // button's baseline between them where it lines up with neither.
          alignItems: { xs: 'stretch', sm: 'flex-start' },
          justifyContent: 'space-between',
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            id="home-greeting"
            variant="h4"
            component="h1"
            sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}
          >
            {firstName ? `Hi, ${firstName}` : 'Hi there'}
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
            {TAGLINE}
          </Typography>
        </Box>

        {/* Full width on phones — where these are the page's primary actions
            and there is a fixed bottom bar competing for the thumb — and inline
            from `sm` up, where a button stretched across a 1440px page reads
            as a banner rather than as a control.

            `flex-start` again at `sm`+, and it earns its keep here: a
            `NewTranscriptButton` whose deployment cannot transcribe grows an
            explanation and a set-up link BELOW its button, and stretching the
            row would drag New note down to the bottom of that column. */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{
            flexShrink: 0,
            width: { xs: '100%', sm: 'auto' },
            alignItems: { xs: 'stretch', sm: 'flex-start' },
          }}
        >
          <NewTranscriptButton
            available={transcriptionAvailable}
            isChecking={isCheckingTranscription}
          />

          {canCreateNote && (
            <Button
              variant="outlined"
              size="large"
              startIcon={<NoteAddIcon />}
              onClick={() => navigate('/notes/new')}
              sx={{ flexShrink: 0, width: { xs: '100%', sm: 'auto' }, whiteSpace: 'nowrap' }}
            >
              New note
            </Button>
          )}
        </Stack>
      </Stack>

      {/* The fourth thing, under the other three — see the header. It gates
          itself on `transcripts:read` and costs this page no request. */}
      <HomeSearchField />
    </Box>
  );
}

export default HomeHero;
