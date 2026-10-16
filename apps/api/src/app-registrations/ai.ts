// =============================================================================
// This app's AI features (issue #473, epic #472)
// =============================================================================
//
// Every place this product calls a model is a registered AI feature: the platform
// stamps the feature id on the usage row (so `GET /api/admin/ai/usage` groups by
// it), checks the feature's `needs` against the chosen model's capabilities, and
// lists it at `GET /api/ai/features`. The target resolver
// (`ai-port/kvox-ai-target-resolver.ts`) maps a feature to a connected-knowledge
// task through `KVOX_FEATURE_TASK`.
//
//   id                      call site                              task
//   note_generate           note.generate, template preview        none (default model)
//   note_retitle            note.retitle                           none
//   transcript_name_check   transcript.name_check                  none
//   graph_extract           kg.extract                             graph.extract
//   graph_adjudicate        kg.resolve, dedup, kg.import           graph.adjudicate
//   graph_digest            kg.entity_digest                       graph.digest
//   graph_agent             ask.respond                            graph.agent
//   graph_embed             kg.embed, resolution                   none (catalog)
//   search_embed            search.index, query embedding          none (catalog)
//
// ⚠ A FEATURE ID IS PERMANENT: usage rows carry it. It is lower snake case (the
// platform refuses a dot, `INVALID_ID`), so it is not the task key.
//
// Imported once, from `platform/ai/ai.config.ts`, at module load: the registry
// freezes when the application bootstraps, so a registration from a service would
// fail with `FROZEN`.
// =============================================================================

import { APP_SLUG } from '@app/shared';
import { registerAiFeature, type AiFeatureDefinition } from '@marinoscar/platform-api/ai';

import type { KvoxAiFeatureId } from '../ai-port/features';

const GROUP = APP_SLUG;

/** Every feature, in registration order. The id type pins the list to `KVOX_AI_FEATURES`. */
export const KVOX_AI_FEATURE_DEFINITIONS: ReadonlyArray<
  AiFeatureDefinition & { readonly id: KvoxAiFeatureId }
> = [
  {
    id: 'note_generate',
    label: 'Note generation',
    group: GROUP,
    needs: ['responses', 'streaming'],
  },
  {
    id: 'note_retitle',
    label: 'Note titles',
    group: GROUP,
    needs: ['responses', 'streaming'],
  },
  {
    id: 'transcript_name_check',
    label: 'Transcript name check',
    group: GROUP,
    needs: ['responses', 'streaming'],
  },
  {
    id: 'graph_extract',
    label: 'Graph extraction',
    group: GROUP,
    needs: ['responses', 'structured_output'],
  },
  {
    id: 'graph_adjudicate',
    label: 'Entity matching',
    group: GROUP,
    needs: ['responses', 'structured_output'],
  },
  {
    id: 'graph_digest',
    label: 'Entity digest',
    group: GROUP,
    needs: ['responses', 'structured_output'],
  },
  {
    id: 'graph_agent',
    label: 'Ask (graph agent)',
    group: GROUP,
    needs: ['responses', 'tools', 'streaming'],
  },
  {
    id: 'graph_embed',
    label: 'Graph embeddings',
    group: GROUP,
    needs: ['embeddings'],
  },
  {
    id: 'search_embed',
    label: 'Search embeddings',
    group: GROUP,
    needs: ['embeddings'],
  },
];

for (const definition of KVOX_AI_FEATURE_DEFINITIONS) {
  registerAiFeature(definition);
}
