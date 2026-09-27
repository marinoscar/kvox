/**
 * The effective token limits per permitted model, under the SAVED AI policy
 * (issue #436) — rendered inside the admin AI page's "Limits" section.
 *
 * ⚠ THIS COMPONENT COMPUTES NOTHING. Every number comes from
 * `AiSettingsAdminView.effectiveLimits`, which the API builds with the same
 * budget function every request uses (the deployment's optional caps, the
 * model's own maximum, and the reasoning effort's headroom). Recomputing it here
 * would be a second implementation of that arithmetic, free to disagree with
 * the one that actually spends somebody's tokens.
 *
 * ⚠ AND THEREFORE IT DESCRIBES WHAT IS SAVED, NOT WHAT IS TYPED. When the page's
 * draft caps or reasoning effort differ from the saved ones, `stale` says so in
 * a sentence rather than letting the list quietly contradict the fields above.
 *
 * Provenance reuses `AiModelLimits`' chip and wording, so a model reads the same
 * here as on its permitted-models row. A `'default'` source — the provider's
 * conservative floor, applied because the model's real capacity is unknown — is
 * the one that needs a sentence: it names the fix (type the real numbers on the
 * model's permitted-models entry).
 *
 * Mobile-first: one compact block per model, caption-sized, wrapping rather
 * than scrolling, so a 360px screen shows several models. No `useMediaQuery` —
 * Settings UI Pattern rule 5's gates are untouched.
 */

import { Box, Divider, Stack, Typography } from '@mui/material';

import type { AiEffectiveLimit } from '../../services/ai';
import { AiModelLimitChip, describeModelLimits } from './AiModelLimits';

export interface AiEffectiveLimitsProps {
  limits: AiEffectiveLimit[];
  /** The page's unsaved caps or reasoning effort differ from the saved ones. */
  stale: boolean;
}

function whereFrom(source: 'policy' | 'model'): string {
  return source === 'policy' ? 'your cap' : 'model maximum';
}

function EffectiveLimitRow({ limit }: { limit: AiEffectiveLimit }) {
  const description = describeModelLimits(
    limit.source === 'explicit'
      ? null
      : {
          source: limit.source,
          derivedFrom: limit.derivedFrom,
          contextWindowTokens: limit.modelContextWindowTokens,
          maxOutputTokens: limit.modelMaxOutputTokens,
        },
    limit.source === 'explicit',
  );

  return (
    <Box sx={{ py: 1.25, minWidth: 0 }} data-testid={`ai-effective-limit-${limit.modelId}`}>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.5 }}
      >
        <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
          {limit.label}
        </Typography>
        {limit.label !== limit.modelId && (
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {limit.modelId}
          </Typography>
        )}
        <AiModelLimitChip description={description} />
      </Stack>
      <Typography variant="caption" color="text.secondary" component="p">
        Input {limit.maxInputTokens.toLocaleString()} tokens ({whereFrom(limit.inputSource)}) ·
        Output {limit.maxOutputTokens.toLocaleString()} tokens ({whereFrom(limit.outputSource)})
      </Typography>
      {limit.source === 'default' && (
        <Typography variant="caption" color="warning.main" component="p" sx={{ mt: 0.5 }}>
          This model&apos;s real capacity is unknown, so a conservative floor applies (context{' '}
          {limit.modelContextWindowTokens.toLocaleString()}, output{' '}
          {limit.modelMaxOutputTokens.toLocaleString()} tokens). Type its real numbers on its
          entry under “Permitted models” to lift it.
        </Typography>
      )}
    </Box>
  );
}

export function AiEffectiveLimits({ limits, stale }: AiEffectiveLimitsProps) {
  return (
    <Box sx={{ mb: 3 }} component="section" aria-labelledby="ai-effective-limits-heading">
      <Typography variant="subtitle2" component="h3" id="ai-effective-limits-heading">
        What each model gets
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 0.5 }}>
        {stale
          ? 'Reflects the saved settings — save to see the effect of your changes above.'
          : 'Reflects the saved settings.'}
      </Typography>
      {limits.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No permitted model of the active provider to show. Choose a provider and permit a model
          above.
        </Typography>
      ) : (
        <Stack divider={<Divider flexItem />}>
          {limits.map((limit) => (
            <EffectiveLimitRow key={limit.modelId} limit={limit} />
          ))}
        </Stack>
      )}
    </Box>
  );
}

export default AiEffectiveLimits;
