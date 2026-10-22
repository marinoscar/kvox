/**
 * Fixtures of the path-mode suites (GIC-13, #674): "how is Joe connected to
 * the Copilot rollout". Two paths, each hop with a quote:
 *
 *   Path 1 (strong):   Joe --INVOLVED_IN {stakeholder, skeptical}--> Copilot rollout
 *   Path 2 (moderate): Joe --WORKS_FOR--> Acme Corp --USES {pilot}--> Copilot rollout
 */

import type { EvidenceLink, GraphPathsResponse, GraphSlice } from '../../src/graph/headless/clients/graph.js';
import { ACME_ID, JOE_ID, NOTE_ID, gid } from './graphData.js';

export const COPILOT_ID = gid(40);
export const EDGE_INVOLVED = gid(420);
export const EDGE_WORKS_FOR = gid(410);
export const EDGE_USES = gid(421);

export const COPILOT_SUMMARY = {
  id: COPILOT_ID,
  type: 'Project',
  label: 'Copilot rollout',
  aliases: [],
  mentionCount: 6,
  lastSeenAt: '2026-09-21T10:00:00.000Z',
};

function quote(id: string, subjectId: string, text: string, createdAt: string): EvidenceLink {
  return {
    id,
    subjectKind: 'relation',
    subjectId,
    quote: text,
    createdAt,
    source: {
      kind: 'note',
      noteId: NOTE_ID,
      noteTitle: 'Copilot sync',
      noteVersion: 1,
      currentNoteVersion: 1,
      charStart: 0,
      charEnd: text.length,
      versionChanged: false,
      available: true,
      href: `/notes/${NOTE_ID}?v=1`,
    },
  };
}

export const pathEvidence: EvidenceLink[] = [
  quote(gid(731), EDGE_INVOLVED, 'Joe is a stakeholder on the Copilot rollout but is skeptical about the timeline.', '2026-09-20T10:00:00.000Z'),
  quote(gid(732), EDGE_INVOLVED, 'Joe pushed back on the pilot date again.', '2026-09-10T10:00:00.000Z'),
  quote(gid(733), EDGE_WORKS_FOR, 'Joe works for Acme Corp.', '2026-08-01T10:00:00.000Z'),
  quote(gid(734), EDGE_USES, 'Acme is piloting Copilot with the platform team.', '2026-09-05T10:00:00.000Z'),
];

function node(id: string, type: string, label: string, depth: number) {
  return { id, nodeKind: 'entity' as const, type, label, depth, degree: 3, status: null, occurredAt: null };
}

export function pathsSlice(): GraphSlice {
  return {
    seedIds: [JOE_ID, COPILOT_ID],
    asOf: '2026-09-26T00:00:00.000Z',
    nodes: [node(JOE_ID, 'Person', 'Joe Rivera', 0), node(ACME_ID, 'Organization', 'Acme Corp', 1), node(COPILOT_ID, 'Project', 'Copilot rollout', 0)],
    edges: [
      {
        id: EDGE_INVOLVED,
        type: 'INVOLVED_IN',
        source: JOE_ID,
        target: COPILOT_ID,
        valid: null,
        confidence: 0.9,
        virtual: false,
        props: { role: 'stakeholder', stance: 'skeptical' },
        evidenceCount: 5,
        lastEvidenceAt: '2026-09-20T10:00:00.000Z',
      },
      { id: EDGE_WORKS_FOR, type: 'WORKS_FOR', source: JOE_ID, target: ACME_ID, valid: null, confidence: 0.94, virtual: false, props: {}, evidenceCount: 2, lastEvidenceAt: '2026-08-01T10:00:00.000Z' },
      {
        id: EDGE_USES,
        type: 'USES',
        source: ACME_ID,
        target: COPILOT_ID,
        valid: null,
        confidence: 0.8,
        virtual: false,
        props: { stage: 'pilot' },
        evidenceCount: 1,
        lastEvidenceAt: '2026-09-05T10:00:00.000Z',
      },
    ],
    truncated: false,
    cap: 300,
  };
}

export function pathsResponse(overrides: Partial<GraphPathsResponse> = {}): GraphPathsResponse {
  return {
    from: JOE_ID,
    to: COPILOT_ID,
    asOf: null,
    paths: [
      { nodeIds: [JOE_ID, COPILOT_ID], edgeIds: [EDGE_INVOLVED], hops: 1, score: 1.8 },
      { nodeIds: [JOE_ID, ACME_ID, COPILOT_ID], edgeIds: [EDGE_WORKS_FOR, EDGE_USES], hops: 2, score: 0.9 },
    ],
    slice: pathsSlice(),
    truncated: false,
    ...overrides,
  };
}
