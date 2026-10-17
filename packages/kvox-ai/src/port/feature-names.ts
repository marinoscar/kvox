import { isKvoxAiFeature, type KvoxAiFeatureId } from '../features/index.js';

// =============================================================================
// The port's feature names -> the registered feature ids (issue #490, #579)
// =============================================================================
//
// A domain slice names its feature in the port's vocabulary (`notes.generate`,
// `ask.respond`, ...: `KvoxAiFeature` of `@marinoscar/kvox-api/ports`); the host
// registered the ids of `KVOX_AI_FEATURES` (`note_generate`, `graph_agent`, ...)
// with its usage reports and its gates. This is the one mapping between the two,
// moved from the web port adapter with `createKvoxAi`. A registered id passes
// through as itself.
// =============================================================================

/** The port's feature names, mapped to the registered feature ids. */
const FEATURES: Readonly<Record<string, KvoxAiFeatureId>> = {
  'notes.generate': 'note_generate',
  'notes.title': 'note_retitle',
  'transcripts.name_check': 'transcript_name_check',
  'search.embed': 'search_embed',
  'graph.extract': 'graph_extract',
  'graph.adjudicate': 'graph_adjudicate',
  'graph.digest': 'graph_digest',
  'graph.embed': 'graph_embed',
  'graph.agent': 'graph_agent',
  'ask.respond': 'graph_agent',
};

/**
 * The registered feature id for a port feature or task name.
 *
 * @param name - a port feature name (`notes.generate`) or a registered id (`graph_extract`).
 * @returns the registered id, or `undefined` when the name is unknown.
 * @stability experimental
 */
export function featureOf(name: string): KvoxAiFeatureId | undefined {
  return FEATURES[name] ?? (isKvoxAiFeature(name) ? name : undefined);
}
