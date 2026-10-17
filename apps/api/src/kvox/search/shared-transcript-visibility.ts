import { Injectable } from '@nestjs/common';
import type {
  SearchScopedClient,
  SearchTranscriptAlias,
  SearchTranscriptVisibility,
  SearchViewer,
} from '@marinoscar/kvox-api/search';

import {
  inViewerScope,
  transcriptViewer,
  transcriptVisibleSql,
  type TranscriptViewer,
} from '../../app-sharing/transcript-visibility';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// The web edition's rule for which transcripts search may show (issue #494, epic #491)
// =============================================================================
//
// `@marinoscar/kvox-api/search` restricts every candidate query to the transcripts
// the caller may read, and leaves the rule to the host
// (`SearchTranscriptVisibility`). Its default is "mine". The web edition also shows a
// transcript SHARED with the caller, and a share is a platform grant under forced
// row-level security (issue #485), so this class is the three steps the sharing
// helpers (`app-sharing/transcript-visibility.ts`) already describe:
//
//   1. `viewerFor`            the caller, resolved to the organization their transcripts
//                             are decided in
//   2. `transcriptVisibleSql` the condition for `WHERE`, built by the platform's
//                             `accessibleSql`: live, and owned by the viewer or shared
//                             with them through an active, unexpired grant of any role
//   3. `run`                  the statements, in ONE transaction scoped to that
//                             organization and user (`runInOrg`), so the grants are visible
//
// Nothing here reads `grants` directly (the sharing conformance suite's
// `no-direct-access` rule): every grant goes through the platform's helpers.
// =============================================================================

@Injectable()
export class SharedTranscriptVisibility implements SearchTranscriptVisibility {
  constructor(private readonly prisma: PrismaService) {}

  viewerFor(userId: string): Promise<SearchViewer> {
    return transcriptViewer(this.prisma, userId);
  }

  transcriptVisibleSql(viewer: SearchViewer, alias: SearchTranscriptAlias) {
    return transcriptVisibleSql(viewer as TranscriptViewer, alias);
  }

  run<R>(viewer: SearchViewer, fn: (tx: SearchScopedClient) => Promise<R>): Promise<R> {
    return inViewerScope(this.prisma, viewer as TranscriptViewer, (tx) => fn(tx as unknown as SearchScopedClient));
  }
}
