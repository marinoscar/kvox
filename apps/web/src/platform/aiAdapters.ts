/**
 * What the packaged AI pages take from this app (issue #477, epic #472).
 *
 * `@marinoscar/platform-web/ai/ui` renders the AI, AI models, AI usage and AI
 * Provider (user keys) pages. They are the platform's; what is this app's is
 * handed in here, once, as a module constant, the same shape as
 * `platform/jobsAdapters.ts`:
 *
 *   - `Spinner`: this app's `LoadingSpinner`, for the pages' waits.
 *
 * Mounted by `App.tsx` through `AiWebAdaptersProvider`, inside the platform host
 * and around the routed tree. The AI Playground page is not offered: this is
 * not a general chat product.
 */

import type { AiWebAdapters } from '@marinoscar/platform-web/ai/headless';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

export const appAiAdapters: AiWebAdapters = {
  Spinner: LoadingSpinner,
};
