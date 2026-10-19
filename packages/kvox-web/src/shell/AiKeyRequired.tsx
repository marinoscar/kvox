import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import { Link as RouterLink } from 'react-router-dom';

/**
 * Props of {@link AiKeyRequired}.
 *
 * @stability experimental
 */
export interface AiKeyRequiredProps {
  /**
   * The ONE page the user adds their key on: the host's AI provider settings route
   * (web `/settings/ai`, Desktop `/settings#ai-provider`). A route path, hash
   * included; the packaged pages never assume one.
   */
  settingsPath: string;
  /**
   * The provider's display name, when the host knows which one a feature needs
   * ("OpenAI"). Default: the generic "AI".
   */
  providerName?: string;
}

/**
 * The "add your key to use this" state every AI surface renders when the viewer
 * has no AI key (issue #55, epic #45; packaged by #629).
 *
 * @remarks
 * ONE COMPONENT, ONE MESSAGE, ONE DESTINATION. Every AI surface renders this and
 * nothing else when the key is not configured, so the copy, the link and the
 * reassurance about billing cannot differ between two of them. The host passes the
 * destination (`settingsPath`) and, optionally, a provider name; nothing else is
 * configurable, on purpose.
 *
 * It names the billing: AI features run on the viewer's own provider account, and
 * the application has no key of its own. That is the most important thing a user
 * meets here, so it is said at the point of the ask. It fetches nothing and holds
 * no input: it is a signpost, not a second place to paste a secret.
 *
 * Renders a router `Link`, so mount it inside a router.
 *
 * @param props - see {@link AiKeyRequiredProps}.
 * @returns the state.
 *
 * @example
 * ```tsx
 * const KeyRequired = () => <AiKeyRequired settingsPath="/settings/ai" />;
 * ```
 *
 * @stability experimental
 */
export function AiKeyRequired({ settingsPath, providerName }: AiKeyRequiredProps): ReactElement {
  const subject = providerName ? `${providerName} key` : 'AI key';
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
          Add your {subject} to use this
        </Typography>

        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 460 }}>
          AI features here run on <strong>your own provider account</strong>, using a key
          you supply — so the usage is yours and the bill is yours. This application has no
          AI key of its own and never charges your work to anybody else.
        </Typography>

        <Button
          variant="contained"
          component={RouterLink}
          to={settingsPath}
          startIcon={<KeyOutlinedIcon />}
        >
          Set up your {subject}
        </Button>
      </Stack>
    </Paper>
  );
}
