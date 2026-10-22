/**
 * "Find topics in past meetings" — the Knowledge graph settings card's one
 * deliberate, paid action (#666, epic #661; spec §11).
 *
 * Meetings extracted before Topics existed only carry their subjects as free
 * text. The button queues `kg.topics_promote`, which matches those strings to the
 * caller's Topics and writes DRAFT proposals to review; nothing enters the graph
 * until they commit one. It spends the caller's own AI key, so it is never
 * automatic: it exists only here, behind a click.
 *
 * Rendered only for a viewer who holds `graph:write` on a deployment where
 * connected knowledge is on (`host.features().graphEnabled`, the same gate the
 * other graph surfaces use, so KVox Desktop's flag applies). Layout is CSS only
 * (no media-query read): the button is full width on a phone and natural width
 * from `sm`; the progress and the link sit under it at every width.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormHelperText from '@mui/material/FormHelperText';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import { useHasPermission, useKvoxHost } from '../../../../core/headless/index.js';
import { useTopicsPromote, type UseTopicsPromoteOptions } from '../../../headless/hooks/useTopicsPromote.js';

/** Where the proposals are reviewed. */
const REVIEW_PATH = '/graph/review';

const proposedCopy = (count: number) => `${count} ${count === 1 ? 'topic' : 'topics'} proposed`;

/**
 * Props of {@link TopicsPromoteSection}.
 *
 * @stability experimental
 */
export interface TopicsPromoteSectionProps {
  /** Polling override; mainly for tests. */
  pollOptions?: UseTopicsPromoteOptions;
}

/**
 * The topics-search control of the Knowledge graph settings card; renders nothing without `graph:write` or while connected knowledge is off.
 *
 * @param props - the optional polling override.
 * @returns the section body, or `null`.
 *
 * @stability experimental
 */
export function TopicsPromoteSection({ pollOptions }: TopicsPromoteSectionProps = {}) {
  const graphEnabled = useKvoxHost().features().graphEnabled === true;
  const canWrite = useHasPermission('graph:write');
  const shown = graphEnabled && canWrite;
  const { phase, proposedTopics, error, start } = useTopicsPromote(shown, pollOptions);

  if (!shown) return null;

  const working = phase === 'working';

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Meetings you already have list their subjects as plain text. This finds them and proposes
        them as Topics for you to review; nothing is added to your graph until you accept.
      </Typography>
      <Button
        variant="outlined"
        onClick={() => void start()}
        disabled={working}
        sx={{ width: { xs: '100%', sm: 'auto' } }}
      >
        Find topics in past meetings
      </Button>
      <FormHelperText sx={{ mt: 1 }}>Uses your AI key. It runs only when you ask.</FormHelperText>

      {working && (
        <Box role="status" aria-live="polite" sx={{ mt: 2 }}>
          <LinearProgress aria-label="Finding topics in past meetings" />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {proposedTopics > 0 ? `${proposedCopy(proposedTopics)} so far…` : 'Looking through your meetings…'}
          </Typography>
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}

      {!working && proposedTopics > 0 && (
        <Typography variant="body2" sx={{ mt: 2 }} role="status">
          {proposedCopy(proposedTopics)},{' '}
          <Link component={RouterLink} to={REVIEW_PATH}>
            review now →
          </Link>
        </Typography>
      )}

      {phase === 'done' && proposedTopics === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }} role="status">
          No new topics to propose.
        </Typography>
      )}
    </Box>
  );
}
