/**
 * `AskToolSteps` — what the agent looked up before answering (#380).
 *
 * One collapsible line above the answer — "Searched “Atlas” · Read timeline ·
 * Found 5 results" — built from the turn's recorded `toolCalls` (or the
 * stream's `step` frames while it runs). Expanded while the agent is still
 * working and no answer text has arrived, so the user can watch the lookups
 * happen; collapsed once the answer starts, because by then the answer is
 * what they came for. A user's own toggle always wins over that default.
 *
 * The in-flight step is shown as a spinner row: the stream reports a step once
 * it has FINISHED, so while `running` the next one is by definition underway.
 * A step's error is shown in muted text — the agent carries on after one.
 */

import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Typography from '@mui/material/Typography';
import { useId, useState } from 'react';

import type { AskToolCall } from '../../services/ask';

export interface AskToolStepsProps {
  steps: readonly AskToolCall[];
  /** The turn is pending/streaming. */
  running: boolean;
  /** Answer text has started arriving. */
  answerStarted: boolean;
  /** Start expanded regardless of the default (visual baselines, a11y review). */
  defaultExpanded?: boolean;
}

/** "Found 1 result" / "Found 5 results", or `null` for none. */
function foundLine(steps: readonly AskToolCall[]): string | null {
  const total = steps.reduce((sum, step) => sum + (step.error ? 0 : Math.max(0, step.resultCount)), 0);
  if (total === 0) return null;
  return `Found ${total} ${total === 1 ? 'result' : 'results'}`;
}

/** The one-line summary the collapsed control shows. */
export function askStepsSummary(steps: readonly AskToolCall[], running: boolean): string {
  const parts = steps.map((step) => step.summary || step.name).filter(Boolean);
  const found = foundLine(steps);
  if (found) parts.push(found);
  if (parts.length === 0) return running ? 'Looking things up…' : 'No lookups';
  return parts.join(' · ');
}

export function AskToolSteps({ steps, running, answerStarted, defaultExpanded }: AskToolStepsProps) {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(defaultExpanded ?? null);
  const listId = useId();
  const working = running && !answerStarted;

  if (steps.length === 0 && !working) return null;

  const expanded = userExpanded ?? !answerStarted;
  const summary = askStepsSummary(steps, working);

  return (
    <Box sx={{ mb: 1 }}>
      <ButtonBase
        onClick={() => setUserExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={listId}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          maxWidth: '100%',
          borderRadius: 1,
          px: 0.5,
          py: 0.25,
          color: 'text.secondary',
          textAlign: 'left',
        }}
      >
        {working ? (
          <CircularProgress size={14} aria-hidden />
        ) : (
          <ManageSearchIcon fontSize="small" aria-hidden />
        )}
        <Typography variant="caption" component="span" noWrap sx={{ minWidth: 0 }}>
          {summary}
        </Typography>
        {expanded ? <ExpandLessIcon fontSize="small" aria-hidden /> : <ExpandMoreIcon fontSize="small" aria-hidden />}
      </ButtonBase>
      <Collapse in={expanded} unmountOnExit>
        <Box
          component="ol"
          id={listId}
          aria-label="Lookups"
          sx={{ listStyle: 'none', m: 0, mt: 0.5, pl: 3.5, pr: 0, display: 'grid', gap: 0.25 }}
        >
          {steps.map((step) => (
            <Box component="li" key={step.index}>
              <Typography variant="caption" component="p" sx={{ overflowWrap: 'anywhere' }}>
                {step.summary || step.name}
                {!step.error && (
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {` — ${step.resultCount} ${step.resultCount === 1 ? 'result' : 'results'}`}
                  </Box>
                )}
              </Typography>
              {step.error && (
                <Typography variant="caption" component="p" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                  {step.error}
                </Typography>
              )}
            </Box>
          ))}
          {working && (
            <Box component="li" sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <CircularProgress size={12} aria-hidden />
              <Typography variant="caption" color="text.secondary">
                Looking things up…
              </Typography>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

export default AskToolSteps;
