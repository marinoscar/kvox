/**
 * The top of the signed-in home page — issue #32, epic #19.
 *
 * Three things, in the order a phone screen can afford them: who this is, what
 * the product is for, and the one action that starts the flow.
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
 */

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { TAGLINE } from '@app/shared';

import { NewTranscriptButton } from './NewTranscriptButton';

export interface HomeHeroProps {
  /** The signed-in user's effective display name, or null when they have none. */
  displayName: string | null;
  /** `GET /api/transcription/config` said this deployment can transcribe. */
  transcriptionAvailable: boolean;
  /** The capability probe has not answered yet. */
  isCheckingTranscription?: boolean;
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
}: HomeHeroProps) {
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

        {/* Full width on phones — where it is the page's primary action and
            there is a fixed bottom bar competing for the thumb — and inline
            from `sm` up, where a button stretched across a 1440px page reads
            as a banner rather than as a control. */}
        <Box sx={{ flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}>
          <NewTranscriptButton
            available={transcriptionAvailable}
            isChecking={isCheckingTranscription}
          />
        </Box>
      </Stack>
    </Box>
  );
}

export default HomeHero;
