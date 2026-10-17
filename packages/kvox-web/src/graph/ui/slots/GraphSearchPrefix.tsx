import { useHasPermission, useKvoxHost } from '../../../core/headless/index.js';
import { EntitySearchHits } from '../components/EntitySearchHits.js';

/**
 * The props of {@link GraphSearchPrefix}.
 *
 * @stability experimental
 */
export interface GraphSearchPrefixProps {
  /** The library search box's raw value. */
  query: string;
}

/**
 * Knowledge-graph entity hits ("People and organizations") above a library's
 * ranked search results. Fills the `SearchPrefix` slot of the transcripts and
 * the notes libraries.
 *
 * @remarks
 * Renders nothing unless connected knowledge is on (`host.features().graphEnabled`)
 * and the viewer holds `graph:read`, so a host can wire it unconditionally. A
 * failed request, no hits and an empty box also render nothing: search must
 * never break because the graph failed.
 *
 * @param props - See {@link GraphSearchPrefixProps}.
 * @returns The hits, or nothing.
 *
 * @stability experimental
 * @extensionPoint slot
 */
export function GraphSearchPrefix({ query }: GraphSearchPrefixProps) {
  const graphEnabled = useKvoxHost().features().graphEnabled === true;
  const canRead = useHasPermission('graph:read');
  if (!graphEnabled || !canRead) return null;
  return <EntitySearchHits query={query} />;
}
