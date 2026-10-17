// =============================================================================
// Test helper: the Ask slice's turn over a real database (issue #497, epic #491)
// =============================================================================
//
// `@marinoscar/kvox-api/ask` is built over ports. The real-Postgres suites build the services by
// hand over a plain `PrismaClient`, and bind each port the way the web edition does where that is
// cheap: the REAL `KVOX_AI` binding (`createWebKvoxAi`: `createKvoxAi` over the real
// `PlatformAiRuntime`, #579) whose platform stream is scripted (`FakeAskStream`: the model is the
// only fake, the event mapping and everything above it are production code), the real jobs adapter
// over the real queue, and the real read services and tools over the real rows.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import { AskAccessService, resolveAskOptions, type AskModuleOptions } from '@marinoscar/kvox-api/ask';
import { internals } from '@marinoscar/kvox-api/ask/testing';
import {
  EntityBriefService,
  GraphAccessService,
  GraphAiRunResolver,
  GraphEvidenceService,
  GraphNeighborhoodService,
  GraphOntologyService,
  GraphPreferencesService,
  GraphReadService,
} from '@marinoscar/kvox-api/graph';
import { NoteAccessService } from '@marinoscar/kvox-api/notes';
import type { KvoxJob } from '@marinoscar/kvox-api/ports';

import { SharedTranscriptVisibility } from '../../src/kvox/search/shared-transcript-visibility';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createFakeAskPort, type FakeAskStream } from '../../scripts/ask-eval/fake-provider';
import { EntityViewService } from '../graph/package-internals';
import { createDbObjectStore, UNUSED_STORAGE } from './db-managed-objects.helper';
import { createAllowAllIdentity, createDbJobs, createDbSettings } from './graph-ports.helper';
import { createTranscriptAccess } from './sharing-kit.helper';

/** A platform `jobs` row as the handler is handed it. */
export function toKvoxJob(job: { id: string; type: string; subjectType: string | null; subjectId: string | null; payload: unknown; attempts: number; orgId: string | null }): KvoxJob {
  return {
    id: job.id,
    type: job.type,
    subjectType: job.subjectType,
    subjectId: job.subjectId,
    payload: job.payload,
    attempts: job.attempts,
    orgId: job.orgId,
  };
}

/** The seven tools and the toolset over the real read services. */
export function createAskToolset(prisma: PrismaClient) {
  const p = prisma as unknown as PrismaService;
  const access = new GraphAccessService(p);
  const transcriptAccess = createTranscriptAccess(p);
  const preferences = new GraphPreferencesService(createDbSettings(prisma));
  const ontology = new GraphOntologyService(p, preferences);
  const visibility = new SharedTranscriptVisibility(p);
  const reads = new GraphReadService(p, access, ontology, transcriptAccess, visibility);
  const neighborhood = new GraphNeighborhoodService(p, access, ontology);
  const evidence = new GraphEvidenceService(p, access, transcriptAccess, new NoteAccessService(p), createDbObjectStore(prisma, UNUSED_STORAGE));
  // The document leg's own visibility is SearchService's (and its specs'); stubbed here.
  const search = { search: async () => ({ results: [], nextCursor: null }) };
  const brief = new EntityBriefService(
    p,
    access,
    ontology,
    new EntityViewService(p),
    search as never,
    visibility,
    { resolve: async () => { throw new Error('the Ask tool must never resolve a digest model'); } } as never,
    { isRegistered: () => { throw new Error('the Ask tool must never reach the queue'); } } as never,
    { enqueue: async () => { throw new Error('the Ask tool must never enqueue'); } } as never,
  );

  return {
    visibility,
    toolset: new internals.AskToolset(
      new internals.SearchTool(reads, search as never, p, visibility),
      new internals.GetEntityTool(reads, ontology, p),
      new internals.NeighborsTool(neighborhood, p),
      new internals.TimelineTool(reads, p),
      new internals.EvidenceTool(evidence, p),
      new internals.EntityBriefTool(brief, p),
      new internals.ListCommitmentsTool(p),
      preferences,
    ),
  };
}

/**
 * The posting service and the `ask.respond` handler over the real tables, tools and queue, with the
 * model scripted at the platform stream.
 */
export function createAskTurn(
  prisma: PrismaClient,
  stream: FakeAskStream,
  options: { model?: string; limits?: AskModuleOptions['limits'] } = {},
) {
  const p = prisma as unknown as PrismaService;
  const { toolset, visibility } = createAskToolset(prisma);
  const { port: jobs } = createDbJobs(prisma);
  // The task-model state is scripted; readiness, `chat()` and everything under them is production
  // code over the fake stream.
  const { ai } = createFakeAskPort(stream, { model: options.model ?? 'gpt-test' });
  const resolver = new GraphAiRunResolver(ai, createDbSettings(prisma));
  const service = new internals.AskMessagesService(p, new AskAccessService(p), resolver, jobs);
  const handler = new internals.AskRespondHandler(
    jobs,
    p,
    ai,
    createAllowAllIdentity(),
    resolver,
    toolset,
    visibility,
    resolveAskOptions({ limits: options.limits }),
  );

  return { service, handler, toolset, ai, resolver, jobs };
}
