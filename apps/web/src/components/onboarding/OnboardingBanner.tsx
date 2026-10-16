/**
 * The shell banner: "N of M required steps left" (issue #277, epic #271; on the platform
 * onboarding hooks since #481, epic #478).
 *
 * The platform ships the checklist, the Setup guide, Get started and the welcome dialog, and
 * deliberately no banner: "what is left to set up" is a property of the session rather than
 * of whatever page is open, and where it sits in the shell is the app's decision. This is
 * that banner, rebuilt over `useOnboarding()` (`@marinoscar/platform-web/onboarding/headless`),
 * and mounted once in `Layout.tsx`.
 *
 * It renders NOTHING (no element, no spacing) while loading, for a read that failed or
 * returned no block, once every required step is done, for anyone who has put the checklist
 * away, and on the page it would link to.
 *
 * ONE AUDIENCE AT A TIME, ADMINISTRATOR FIRST. An administrator is also a user, and the two
 * checklists are separate surfaces with separate dismissals (`adminDismissedAt` and
 * `checklistDismissedAt`): putting the personal checklist away must not hide the
 * deployment's, which is the one that is about the application being unusable. When the
 * deployment still has a required step open, the banner is about that; when it has not, or
 * it was dismissed, and the account's own required steps are open, it is about those.
 *
 * REQUIRED STEPS ONLY. `blocked` counts as open: a deployment that cannot transcribe has not
 * finished being set up merely because the reason is somebody else's.
 */

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { useOnboarding } from '@marinoscar/platform-web/onboarding/headless';
import type { OnboardingBlock, OnboardingResponse } from '@marinoscar/platform-web/onboarding/headless';
import { GETTING_STARTED_PATH, SETUP_GUIDE_PATH } from '@marinoscar/platform-web/onboarding/ui';

import { APP_NAME } from '@app/shared';

export type BannerAudience = 'admin' | 'user';

const TITLE_ID = 'onboarding-banner-title';

const VISUALLY_HIDDEN = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: -1,
  overflow: 'hidden',
  padding: 0,
  position: 'absolute' as const,
  whiteSpace: 'nowrap' as const,
  width: '1px',
};

interface AudienceCopy {
  path: string;
  landmark: string;
  detail: string;
  dismissLabel: string;
  confirmation: string;
}

export const BANNER_COPY: Record<BannerAudience, AudienceCopy> = {
  admin: {
    path: SETUP_GUIDE_PATH,
    landmark: 'Deployment setup',
    detail: `Until they are done, the people using this ${APP_NAME} deployment cannot use the features behind them.`,
    dismissLabel: 'Dismiss the deployment setup checklist',
    confirmation: 'Setup is still here whenever you want it: Settings → Setup guide.',
  },
  user: {
    path: GETTING_STARTED_PATH,
    landmark: 'Getting started',
    detail: 'A few small things make this account yours. None of them takes long.',
    dismissLabel: 'Dismiss the getting started checklist',
    confirmation: 'Your checklist is still here whenever you want it: Settings → Getting started.',
  },
};

/** How many required steps a block has, and how many of them are not done. */
export function requiredProgress(block: OnboardingBlock) {
  const required = block.steps.filter((step) => step.tier === 'required');
  const remaining = required.filter((step) => step.status !== 'done').length;
  const total = required.length;
  const done = total - remaining;
  return { total, remaining, done, percent: total === 0 ? 0 : (done / total) * 100 };
}

/** Which checklist the banner is about, or `null` when it has nothing to say. */
export function chooseBannerAudience(state: OnboardingResponse | null): BannerAudience | null {
  if (!state) return null;
  const outstanding = (block: OnboardingBlock | null, dismissedAt: string | null) =>
    Boolean(block && dismissedAt === null && requiredProgress(block).remaining > 0);

  if (outstanding(state.admin, state.settings.adminDismissedAt)) return 'admin';
  if (outstanding(state.user, state.settings.checklistDismissedAt)) return 'user';
  return null;
}

export function OnboardingBanner() {
  const { state, isLoading, dismissAdmin, dismissChecklist } = useOnboarding();
  const { pathname } = useLocation();
  // The audience whose dismissal was just made: the confirmation outlives the banner it came from.
  const [dismissedAudience, setDismissedAudience] = useState<BannerAudience | null>(null);

  if (dismissedAudience) {
    const copy = BANNER_COPY[dismissedAudience];
    return (
      <Snackbar
        open
        autoHideDuration={8000}
        onClose={() => setDismissedAudience(null)}
        message={copy.confirmation}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        action={
          <Button component={RouterLink} to={copy.path} color="inherit" size="small">
            Open
          </Button>
        }
      />
    );
  }

  if (isLoading) return null;

  const audience = chooseBannerAudience(state);
  if (!audience || !state) return null;

  const block = audience === 'admin' ? state.admin : state.user;
  if (!block) return null;

  const copy = BANNER_COPY[audience];

  // The banner points at a page; on that page, and under it, it would point at itself.
  if (pathname === copy.path || pathname.startsWith(`${copy.path}/`)) return null;

  const { total, remaining, percent } = requiredProgress(block);
  const subject = audience === 'admin' ? APP_NAME : 'your account';
  const headline = `${remaining} of ${total} required ${
    total === 1 ? 'step' : 'steps'
  } left to finish setting up ${subject}`;

  return (
    <Paper component="section" variant="outlined" aria-labelledby={TITLE_ID} sx={{ p: 2, mb: 3 }}>
      {/* The landmark's name, visually hidden: the heading below already says this in the
          user's own words, and a landmark called "region" is one nobody can navigate to. */}
      <Box component="span" id={TITLE_ID} sx={VISUALLY_HIDDEN}>
        {copy.landmark}
      </Box>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
      >
        <Box aria-hidden sx={{ display: { xs: 'none', sm: 'flex' }, color: 'primary.main' }}>
          <RocketLaunchOutlinedIcon />
        </Box>

        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
            {headline}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {copy.detail}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={percent}
            aria-label="Required setup progress"
            sx={{
              mt: 1.5,
              height: 6,
              borderRadius: 1,
              '@media (prefers-reduced-motion: reduce)': {
                '& .MuiLinearProgress-bar': { transition: 'none' },
              },
            }}
          />
        </Box>

        <Stack
          direction="row"
          spacing={1}
          sx={{ flexShrink: 0, justifyContent: { xs: 'flex-end', sm: 'flex-start' } }}
        >
          <Button component={RouterLink} to={copy.path} variant="contained" size="small">
            Continue
          </Button>
          <Button
            size="small"
            color="inherit"
            aria-label={copy.dismissLabel}
            onClick={() => {
              setDismissedAudience(audience);
              void (audience === 'admin' ? dismissAdmin() : dismissChecklist());
            }}
          >
            Dismiss
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}

export default OnboardingBanner;
