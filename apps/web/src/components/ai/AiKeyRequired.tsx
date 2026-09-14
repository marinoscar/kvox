/**
 * The "add your key to use this" state — issue #55, epic #45.
 *
 * =============================================================================
 * ONE COMPONENT, ONE MESSAGE, ONE DESTINATION
 * =============================================================================
 *
 * Every AI surface in this epic (#56, #57, #58, #59) renders THIS and nothing
 * else when `useAiConfig().keyConfigured` is false. That is the issue's
 * rejected alternative made structural: four pages each inventing their own
 * empty state is four copies of one message, and the moment the copy, the link
 * or the reassurance about billing differs between two of them, a user who read
 * one and then met the other has been told two different things about their own
 * credential.
 *
 * So this component takes NO PROPS. Not a `title`, not a `description`, not a
 * `feature` name to interpolate. Every one of those would be a seam along which
 * the four surfaces could drift, and the thing being said is identical in all
 * four places: you need your own key, here is what that means, here is the one
 * page that does it.
 *
 * WHY IT NAMES THE BILLING. "Add your API key" alone reads like a setup chore
 * the application is imposing. The reason it is being asked — this application
 * has no AI key of its own and never charges AI usage to anybody but the person
 * who typed the key — is the single most important thing a user meets here, and
 * it belongs at the point of the ask rather than behind the link.
 *
 * IT DOES NOT FETCH ANYTHING. The caller already holds the `useAiConfig()`
 * answer it branched on; a second request from inside the empty state would be
 * one more round trip for a question just answered.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import { Link as RouterLink } from 'react-router-dom';

/** The one destination. Every AI surface's empty state links here and nowhere else. */
export const AI_KEY_SETTINGS_PATH = '/settings/ai';

export function AiKeyRequired() {
  return (
    <Paper
      variant="outlined"
      // `region` + the heading it is labelled by, so a screen-reader user
      // reaches this as a named landmark rather than as loose text where the
      // feature was supposed to be.
      component="section"
      aria-labelledby="ai-key-required-heading"
      sx={{ p: { xs: 2, sm: 3 }, textAlign: 'center' }}
    >
      <Stack spacing={2} sx={{ alignItems: 'center' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 56,
            height: 56,
            borderRadius: '50%',
            bgcolor: 'action.hover',
          }}
        >
          <KeyOutlinedIcon color="action" fontSize="large" />
        </Box>

        <Typography id="ai-key-required-heading" variant="h6" component="h2">
          Add your AI key to use this
        </Typography>

        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ maxWidth: 460 }}
        >
          AI features here run on <strong>your own provider account</strong>, using a key
          you supply — so the usage is yours and the bill is yours. This application has no
          AI key of its own and never charges your work to anybody else.
        </Typography>

        <Button
          variant="contained"
          component={RouterLink}
          to={AI_KEY_SETTINGS_PATH}
          startIcon={<KeyOutlinedIcon />}
        >
          Set up your AI key
        </Button>
      </Stack>
    </Paper>
  );
}

export default AiKeyRequired;
