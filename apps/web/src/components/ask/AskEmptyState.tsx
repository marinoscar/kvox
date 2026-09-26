/**
 * `AskEmptyState` — `/ask` with no conversation open (#380).
 *
 * "Ask about your meetings", and three suggested questions: up to three built
 * from the user's own recent entities ("What's the latest on {label}?") plus
 * two generic ones. Choosing one ASKS it — the owner creates the conversation
 * and posts the question in one go — rather than merely filling the box.
 *
 * The entity suggestions are best-effort: a slow, failed or empty graph read
 * simply leaves the generic questions.
 */

import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { useGraphEntities } from '../../hooks/useGraphEntities';
import type { GraphEntitySummary } from '../../services/graph';

export const ASK_GENERIC_SUGGESTIONS = [
  'What did I commit to this week?',
  'Which decisions changed last month?',
] as const;

/** Suggested questions: the entities first (at most three in all), then the generic ones. */
export function askSuggestions(entities: readonly Pick<GraphEntitySummary, 'label'>[]): string[] {
  const fromEntities = entities.slice(0, 3).map((entity) => `What's the latest on ${entity.label}?`);
  return [...fromEntities, ...ASK_GENERIC_SUGGESTIONS];
}

export interface AskEmptyStateProps {
  onAsk: (question: string) => void;
  disabled?: boolean;
}

export function AskEmptyState({ onAsk, disabled = false }: AskEmptyStateProps) {
  const recent = useGraphEntities({ limit: 3, debounceMs: 0 });
  const suggestions = askSuggestions(recent.error ? [] : recent.data);

  return (
    <Box sx={{ py: { xs: 3, sm: 6 }, px: 1, textAlign: 'center', maxWidth: 560, mx: 'auto' }}>
      <QuestionAnswerOutlinedIcon color="primary" sx={{ fontSize: 40, mb: 1 }} aria-hidden />
      <Typography variant="h5" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
        Ask about your meetings
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Answers come only from your own reviewed notes and transcripts, with a source for every claim.
      </Typography>
      <Stack spacing={1} component="ul" aria-label="Suggested questions" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {suggestions.map((question) => (
          <Box component="li" key={question}>
            <Button
              variant="outlined"
              fullWidth
              disabled={disabled}
              onClick={() => onAsk(question)}
              sx={{ justifyContent: 'flex-start', textTransform: 'none', textAlign: 'left' }}
            >
              {question}
            </Button>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

export default AskEmptyState;
