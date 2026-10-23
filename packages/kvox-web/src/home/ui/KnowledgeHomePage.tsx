// The page `kvoxHomeRoutes` draws (#721): the packaged Home with the
// knowledge-first sections. Not exported: a host that wants it with slots mounts
// `KvoxHomePage` with `sections={KVOX_KNOWLEDGE_HOME_SECTIONS}` itself.

import { KVOX_KNOWLEDGE_HOME_SECTIONS } from '../headless/index.js';
import { KvoxHomePage } from './KvoxHomePage.js';

export function KnowledgeHomePage() {
  return <KvoxHomePage sections={KVOX_KNOWLEDGE_HOME_SECTIONS} />;
}
