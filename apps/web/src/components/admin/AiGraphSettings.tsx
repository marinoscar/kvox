/**
 * "Connected knowledge" — the `ai.graphEnabled` switch on `/admin/settings/ai`
 * (issue #361, contract from #360; spec `docs/specs/ontology.md` §20 and §15).
 *
 * A SECTION OF THE EXISTING AI CARD, NOT A CARD OF ITS OWN. `graphEnabled` is a
 * field of the `ai` system-settings namespace, gated by the same
 * `ai_config:read`/`:write` pair the AI card carries (#477) — a second card for
 * one namespace would split one policy across two destinations (Settings UI
 * Pattern rules 1 and 3). It is mounted in the `Sections` slot of the
 * platform's `AiConfigPage` and saved through `PUT /api/ai-tasks/settings`.
 *
 * ⚠ THE COPY STATES THE COST MODEL, AND THAT IS NOT DECORATION. Every graph
 * request runs on the requesting user's OWN key and bills their own provider
 * account (§15, `docs/specs/notes.md` §9). An administrator turning this on is
 * deciding that other people may spend their money on it, so the sentence that
 * says so sits beside the switch rather than in documentation.
 *
 * Presentational only: the page owns the draft and the save. No
 * `useMediaQuery` — nothing here re-gates on a breakpoint (rule 5).
 */

import { Alert, FormControlLabel, Paper, Switch, Typography } from '@mui/material';

export interface AiGraphSettingsProps {
  /** The draft `graphEnabled`. */
  value: boolean;
  onChange: (next: boolean) => void;
  /** Whether AI is switched on deployment-wide (the platform's switch), for the "AI is off" notice. */
  aiEnabled: boolean;
  /** True for a read-only administrator (`ai_config:read` only). */
  disabled: boolean;
}

export function AiGraphSettings({ value, onChange, aiEnabled, disabled }: AiGraphSettingsProps) {
  return (
    <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
      <Typography variant="h6" component="h2" gutterBottom>
        Connected knowledge
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        When on, each finished note can be turned into a reviewable graph proposal, and users can
        ask questions about their graph. Every request runs on the requesting user&apos;s own AI key
        and bills their provider account. Nothing enters anyone&apos;s graph without their review.
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={value}
            onChange={(event) => onChange(event.target.checked)}
            disabled={disabled}
          />
        }
        label="Enable connected knowledge"
      />

      {/* Info, not an error: the two switches are independent axes, and the
          administrator may be turning AI on in the same save. */}
      {value && !aiEnabled && (
        <Alert severity="info" sx={{ mt: 1 }}>
          AI is switched off above, so connected knowledge cannot run until it is on.
        </Alert>
      )}
    </Paper>
  );
}

export default AiGraphSettings;
