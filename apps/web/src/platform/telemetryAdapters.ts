/**
 * What the packaged telemetry pages take from this app (issue #471, epic #467;
 * the AI hooks since #477, epic #472).
 *
 * `@marinoscar/platform-web/telemetry/ui` renders the Telemetry settings page,
 * the Explorer and the Dashboard. The pages are the platform's; what is this
 * app's is handed in here, once, as a module constant, the same shape as
 * `platform/jobsAdapters.ts`:
 *
 *   - `Spinner`: this app's `LoadingSpinner`.
 *   - `useAiEnabled` / `useAssistantModels`: the telemetry assistant's two app
 *     hooks, over the platform AI slice. The assistant runs on the platform's AI
 *     service, so "AI is on" is the platform's shell-wide answer
 *     (`GET /api/ai/config`, mounted once by `AppAiConfigProvider`) and the
 *     picker lists the platform's enabled `ai_models` rows
 *     (`GET /api/admin/ai/models`, `ai_config:read`, which is why the package
 *     calls `useAssistantModels` only for a viewer holding it).
 *
 * The hooks are called by the package on every render of its pages, so they
 * are module-level functions, never recreated.
 */

import { useMemo } from 'react';
import { useAiConfig, useAiModels } from '@marinoscar/platform-web/ai/headless';
import type {
  TelemetryAiEnabledState,
  TelemetryAssistantModelsState,
  TelemetryWebAdapters,
} from '@marinoscar/platform-web/telemetry/headless';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

/** The id the catalogue gives a model that can call tools (the assistant needs it). */
const TOOLS_CAPABILITY = 'tools';

/** Enabled models only; the catalogue's page size cap is generous for a picker. */
const ASSISTANT_MODEL_FILTER = { enabled: true, pageSize: 100 } as const;

function useAiEnabled(): TelemetryAiEnabledState {
  const { config, isLoading } = useAiConfig();
  return { enabled: config.enabled, isLoading };
}

function useAssistantModels(): TelemetryAssistantModelsState {
  const { models, isLoading, error } = useAiModels(ASSISTANT_MODEL_FILTER);
  const options = useMemo(
    () =>
      models.map((model) => ({
        id: model.id,
        provider: model.provider,
        modelId: model.modelId,
        label: model.displayName ?? model.modelId,
        supportsToolCalling: model.capabilities?.capabilities.includes(TOOLS_CAPABILITY) ?? false,
      })),
    [models],
  );
  return { models: options, isLoading, error };
}

export const appTelemetryAdapters: TelemetryWebAdapters = {
  useAiEnabled,
  useAssistantModels,
  Spinner: LoadingSpinner,
};
