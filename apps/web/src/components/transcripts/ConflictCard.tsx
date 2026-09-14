/**
 * "Someone changed this segment" — issue #31, epic #19.
 *
 * A 409 is not an error the user caused and it is not a failure of their work:
 * both versions of the line exist and both are legitimate. So this is a CARD
 * with two buttons, not an alert with an OK — the only thing the application
 * genuinely does not know is which one the person wants.
 *
 * ⚠ "Keep mine" IS THE FIRST BUTTON AND THE DEFAULT-LOOKING ONE. The user's
 * text is already on screen (the hook keeps it through the refetch), so making
 * "use theirs" the prominent choice would invite a reflexive tap that discards
 * the thing they just typed. Either choice is recoverable through the version
 * history, but only one of them is recoverable without leaving the page.
 *
 * An entity the other editor DELETED has no `currentRev`, so there is nothing
 * to write the local text back onto — the card says so and offers only the one
 * action that can succeed.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { EditConflict } from '../../hooks/useTranscriptOperations';

interface ConflictCardsProps {
  conflicts: readonly EditConflict[];
  onResolve: (id: string, choice: 'mine' | 'theirs') => void;
}

function Quote({ title, text }: { title: string; text: string }) {
  return (
    <Box sx={{ mt: 0.5 }}>
      <Typography variant="caption" color="text.secondary" component="div">
        {title}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          borderLeft: 2,
          borderColor: 'divider',
          pl: 1,
          // A correction is often whitespace, and a quote that collapses it
          // shows the two candidates as identical.
          whiteSpace: 'pre-wrap',
        }}
      >
        {text || <em>(empty)</em>}
      </Typography>
    </Box>
  );
}

export function ConflictCards({ conflicts, onResolve }: ConflictCardsProps) {
  if (conflicts.length === 0) return null;

  return (
    <Stack spacing={1.5} sx={{ mb: 2 }}>
      {conflicts.map((conflict) => {
        const deleted = conflict.currentRev === null;
        return (
          <Alert key={conflict.id} severity="warning" icon={false}>
            <AlertTitle>
              {deleted
                ? 'Someone deleted this while you were editing'
                : 'Someone changed this segment'}
            </AlertTitle>
            <Typography variant="caption" color="text.secondary">
              {conflict.label}
            </Typography>

            <Quote title="Yours" text={conflict.mine} />
            {!deleted && <Quote title="Theirs" text={conflict.theirs} />}

            <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
              {!deleted && (
                <Button
                  size="small"
                  variant="contained"
                  onClick={() => onResolve(conflict.id, 'mine')}
                >
                  Keep mine
                </Button>
              )}
              <Button size="small" onClick={() => onResolve(conflict.id, 'theirs')}>
                {deleted ? 'Accept the deletion' : 'Use theirs'}
              </Button>
            </Stack>
          </Alert>
        );
      })}
    </Stack>
  );
}

export default ConflictCards;
