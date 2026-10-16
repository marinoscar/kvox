// =============================================================================
// The AI slice's composition (issue #473, epic #472)
// =============================================================================
//
// `AiModule.forRoot` mounts the platform AI slice: `GET /api/ai/config`,
// `/api/ai/keys` (a user's own provider keys), the responses / embeddings / images
// / audio / realtime / runs routes, `/api/ai/features`, `/api/ai/usage`,
// `/api/admin/ai/*` (the deployment policy, the model catalogue, deployment and
// organization keys, usage), the `ai.*` job types and the kill switch.
//
// `providers: ['openai']`: this product has one vendor today; the other four
// provider modules stay out of the graph (their settings slots stay, inert).
// `perUserDefaultModel: false`: the model is chosen per TASK by
// `KvoxAiTargetResolver`, so the platform's per-user default-model picker is
// hidden. A caller's own per-run pick (`requested.model`) is unaffected.
//
// ORDER: `app-registrations/ai.ts` registers the AI features, and the registry
// freezes when the application bootstraps, so it is imported HERE, at module
// load, never from a service. The settings registry (which lists the `ai`
// namespace with this app's extension) is imported first, like the storage config.
//
// THE CONSTANT BELOW IS A SINGLETON: a module that needs the AI services imports
// `aiModule` (the same dynamic-module object), never a second `AiModule.forRoot()`.
//
// The old per-feature `AiModule` (`src/ai/`, the OpenAI provider and the
// per-user credential store) stays mounted beside this one until #477.
// =============================================================================

import { AiModule } from '@marinoscar/platform-api/ai';

import '../../settings/registry';
import '../../app-registrations/ai';
import { AiHostModule } from './ai-host.module';

export const aiModule = AiModule.forRoot({
  imports: [AiHostModule],
  providers: ['openai'],
  perUserDefaultModel: false,
});
