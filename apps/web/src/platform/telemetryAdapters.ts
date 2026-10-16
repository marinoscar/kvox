/**
 * What the packaged telemetry pages take from this app (issue #471, epic #467).
 *
 * `@marinoscar/platform-web/telemetry/ui` renders the Telemetry settings page,
 * the Explorer and the Dashboard. The pages are the platform's; what is this
 * app's is handed in here, once, as a module constant, the same shape as
 * `platform/jobsAdapters.ts`:
 *
 *   - `Spinner`: this app's `LoadingSpinner`.
 *   - `useAiEnabled` / `useAssistantModels`: the telemetry assistant's two app
 *     hooks.
 *
 * PLATFORM-ADOPTION-SHIM(#472): the assistant needs the PLATFORM's AI slice (a
 * deployment-wide enabled flag and a model catalogue behind `ai_config:read`).
 * This app's AI is still its own, per-user keys on `GET /api/ai/config`, so
 * until #472 adopts the platform AI slice both hooks answer "unavailable": AI is
 * off for the assistant and the picker has no models. The API's AI adapter
 * answers the same, so the pages and the server agree. The hooks are plain
 * constants, not fetchers, so the assistant is hidden without a single request.
 * Replace both with the real hooks in #472.
 */

import type { TelemetryWebAdapters } from '@marinoscar/platform-web/telemetry/headless';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

export const appTelemetryAdapters: TelemetryWebAdapters = {
  // PLATFORM-ADOPTION-SHIM(#472)
  useAiEnabled: () => ({ enabled: false, isLoading: false }),
  // PLATFORM-ADOPTION-SHIM(#472)
  useAssistantModels: () => ({ models: [], isLoading: false, error: null }),
  Spinner: LoadingSpinner,
};
