// =============================================================================
// The stored `kg_graph_layouts` JSON shapes (#371, epic #347)
// =============================================================================
//
// `clusters`  — { version: 1, items: ClusterRow[], clusterEdges, modularity, tooLarge }
// `positions` — { version: 1, types: string[], nodes: [id, x, y, clusterId, typeIndex, degree][] }
//
// Ids and numbers only — NEVER a label (spec §15). Written by the handler,
// parsed by the overview read: the parse is strict so a row from a future
// version (or a hand-edited one) reads as "no usable snapshot" rather than as
// a half-understood picture.
// =============================================================================

import { z } from 'zod';

import type { LayoutOutput } from './compute-layout';

export const LAYOUT_SNAPSHOT_VERSION = 1;

const clusterRowSchema = z.object({
  id: z.number().int(),
  labelEntityId: z.string().nullable(),
  size: z.number().int(),
  x: z.number(),
  y: z.number(),
  radius: z.number(),
  typeCounts: z.record(z.string(), z.number().int()),
  sampleIds: z.array(z.string()),
});

export const storedClustersSchema = z.object({
  version: z.literal(LAYOUT_SNAPSHOT_VERSION),
  items: z.array(clusterRowSchema),
  clusterEdges: z.array(z.object({ a: z.number().int(), b: z.number().int(), weight: z.number() })),
  modularity: z.number(),
  tooLarge: z.boolean(),
});

export const storedPositionsSchema = z.object({
  version: z.literal(LAYOUT_SNAPSHOT_VERSION),
  types: z.array(z.string()),
  nodes: z.array(z.tuple([z.string(), z.number(), z.number(), z.number().int(), z.number().int(), z.number().int()])),
});

export type StoredClusters = z.infer<typeof storedClustersSchema>;
export type StoredPositions = z.infer<typeof storedPositionsSchema>;

export function toStoredClusters(out: LayoutOutput): StoredClusters {
  return {
    version: LAYOUT_SNAPSHOT_VERSION,
    items: out.clusters,
    clusterEdges: out.clusterEdges,
    modularity: out.modularity,
    tooLarge: out.tooLarge,
  };
}

export function toStoredPositions(out: LayoutOutput): StoredPositions {
  return { version: LAYOUT_SNAPSHOT_VERSION, types: out.types, nodes: out.positions };
}
