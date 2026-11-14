/**
 * `SpeakerVoiceSuggestions` — "Speaker B sounds like Person A · 87%" (#827,
 * epic #820).
 *
 * One compact row per still-unnamed speaker that has a pending voice match,
 * drawn right under the speaker list (the panel on a wide window, the chip row
 * on a narrow one). Accept names the speaker after the person; Dismiss means
 * the pair is never suggested again. The suggestions come through the page's
 * `useSpeakerSuggestions` slot; this component imports nothing from the graph.
 *
 * Layout is CSS only (rows that wrap), so it reads no breakpoint and works at
 * phone width.
 */

import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import RecordVoiceOverOutlinedIcon from '@mui/icons-material/RecordVoiceOverOutlined';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';

import type { TranscriptSpeaker } from '../../headless/clients/transcripts.js';
import { speakerColor } from '../../headless/utils/transcriptDisplay.js';
import type { TranscriptSpeakerSuggestion } from '../slots.js';

/**
 * A voice-match score (0 to 1) as a rounded percentage: `0.871` → `87%`.
 *
 * @stability experimental
 */
export function formatVoiceMatchScore(score: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * The props of {@link SpeakerVoiceSuggestions}.
 *
 * @stability experimental
 */
export interface SpeakerVoiceSuggestionsProps {
  /** The speakers as shown, in order; only those with a suggestion get a row. */
  speakers: readonly TranscriptSpeaker[];
  /** `speakerId` to its best pending suggestion. */
  bySpeaker: Readonly<Record<string, TranscriptSpeakerSuggestion>>;
  /** Whether Accept and Dismiss are enabled. */
  canDecide: boolean;
  /** The suggestion a decision is in flight for. */
  busyId: string | null;
  /** Why the last decision failed. */
  error: string | null;
  /** Clears `error`. */
  onClearError: () => void;
  /** Accepts a suggestion. */
  onAccept: (id: string) => void;
  /** Dismisses a suggestion. */
  onDismiss: (id: string) => void;
}

/**
 * The voice-match suggestions of a transcript's unnamed speakers; renders nothing without one.
 *
 * @param props - See {@link SpeakerVoiceSuggestionsProps}.
 * @returns The rows, or `null`.
 *
 * @stability experimental
 */
export function SpeakerVoiceSuggestions({
  speakers,
  bySpeaker,
  canDecide,
  busyId,
  error,
  onClearError,
  onAccept,
  onDismiss,
}: SpeakerVoiceSuggestionsProps) {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const rows = speakers
    .map((speaker) => ({ speaker, suggestion: bySpeaker[speaker.id] }))
    .filter((row): row is { speaker: TranscriptSpeaker; suggestion: TranscriptSpeakerSuggestion } =>
      Boolean(row.suggestion),
    );

  if (rows.length === 0 && !error) return null;

  return (
    <Box component="section" aria-label="Voice match suggestions" sx={{ minWidth: 0 }}>
      {rows.length > 0 && (
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.5 }}>
          <RecordVoiceOverOutlinedIcon fontSize="small" color="action" aria-hidden />
          <Typography variant="caption" color="text.secondary" component="p">
            Voice match
          </Typography>
        </Stack>
      )}
      <Stack spacing={0.5} component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {rows.map(({ speaker, suggestion }) => {
          const busy = busyId === suggestion.id;
          const percent = formatVoiceMatchScore(suggestion.score);
          const disabled = !canDecide || busyId !== null;
          return (
            <Box
              component="li"
              key={suggestion.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                columnGap: 0.5,
                rowGap: 0,
                minWidth: 0,
                py: 0.25,
                pl: 1,
                borderLeft: 3,
                borderColor: speakerColor(speaker.colorIndex, mode),
              }}
            >
              <Typography variant="body2" sx={{ flex: '1 1 12rem', minWidth: 0, overflowWrap: 'anywhere' }}>
                {speaker.displayName} sounds like <strong>{suggestion.personName}</strong> · {percent}
              </Typography>
              <Box sx={{ display: 'flex', flexShrink: 0 }}>
                <Tooltip title={canDecide ? `Name this speaker ${suggestion.personName}` : 'You cannot name speakers here'}>
                  <span>
                    <IconButton
                      size="small"
                      color="primary"
                      disabled={disabled}
                      aria-busy={busy || undefined}
                      aria-label={`Accept: ${speaker.displayName} is ${suggestion.personName}`}
                      onClick={() => onAccept(suggestion.id)}
                    >
                      <CheckIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title={canDecide ? 'Not them, dismiss' : 'You cannot name speakers here'}>
                  <span>
                    <IconButton
                      size="small"
                      disabled={disabled}
                      aria-label={`Dismiss: ${speaker.displayName} is not ${suggestion.personName}`}
                      onClick={() => onDismiss(suggestion.id)}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </Box>
          );
        })}
      </Stack>
      {error && (
        <Alert severity="error" onClose={onClearError} sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
