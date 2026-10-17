// =============================================================================
// `search` — both legs, always (#377; docs/specs/ontology.md §9.4, §21)
// =============================================================================
//
// The one tool that takes free text. It reaches SQL only as a bound parameter:
// the graph leg is `GraphReadService.listEntities({ q })` (trigram on labels
// and aliases), the document leg is `SearchService.search` (FTS + vector, the
// same visibility rules as `GET /api/search`).
//
// §9.4 forbids graph-only answers, so BOTH legs run on every call. `scope` only
// decides which leg gets the full `limit`; the other still contributes up to
// `SECONDARY_LEG_LIMIT` results.
// =============================================================================

import { ForbiddenException, Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';

import { Prisma } from '../../core/index.js';
import { GraphReadService } from '../../graph/index.js';
import { KVOX_PRISMA } from '../../ports/index.js';
import { SEARCH_TRANSCRIPT_VISIBILITY, SearchService, type SearchTranscriptVisibility } from '../../search/index.js';
import type { KvoxAskDb } from '../data/ask-db.js';
import {
  clip,
  isoDate,
  jsonNullableEnum,
  jsonNullableInteger,
  jsonString,
  objectParameters,
  optionalOf,
  plural,
  QUOTE_MAX_CHARS,
  type AskTool,
  type AskToolContext,
  type AskToolResult,
} from './ask-tool.js';
import { typeVisible } from './sensitivity.js';

export const SEARCH_SCOPES = ['all', 'entities', 'documents'] as const;
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 10;
/** What the de-prioritised leg still returns when `scope` names the other one. */
export const SECONDARY_LEG_LIMIT = 3;

const input = z.object({
  query: z.string().trim().min(1).max(200),
  scope: optionalOf(z.enum(SEARCH_SCOPES)),
  limit: optionalOf(z.number().int().min(1).max(SEARCH_MAX_LIMIT)),
});
export type SearchToolInput = z.output<typeof input>;

/** `ts_headline` HTML → plain text: drop `<mark>`, undo the server-side escape. */
export function snippetToText(html: string): string {
  return html
    .replace(/<\/?mark>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

@Injectable()
export class SearchTool implements AskTool<SearchToolInput> {
  readonly name = 'search';
  readonly description =
    "Find people, organizations, projects and meetings by name, and passages in the user's transcripts and notes " +
    'that match the query. Use this first when you do not yet have a reference.';
  readonly parameters = objectParameters({
    query: jsonString('What to look for: a name, a topic or a phrase. 1–200 characters.'),
    scope: jsonNullableEnum(
      SEARCH_SCOPES,
      'Which results matter most: "entities" (names), "documents" (passages) or "all" (default). ' +
        'Both kinds are always searched; the other kind is just shortened.',
    ),
    limit: jsonNullableInteger(`Results per kind, 1–${SEARCH_MAX_LIMIT}. Default ${SEARCH_DEFAULT_LIMIT}.`),
  });
  readonly input = input;

  constructor(
    private readonly graphRead: GraphReadService,
    private readonly search: SearchService,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxAskDb,
    @Inject(SEARCH_TRANSCRIPT_VISIBILITY) private readonly visibility: SearchTranscriptVisibility,
  ) {}

  async run(ctx: AskToolContext, args: SearchToolInput): Promise<AskToolResult> {
    const scope = args.scope ?? 'all';
    const limit = args.limit ?? SEARCH_DEFAULT_LIMIT;
    const entityLimit = scope === 'documents' ? Math.min(SECONDARY_LEG_LIMIT, limit) : limit;
    const documentLimit = scope === 'entities' ? Math.min(SECONDARY_LEG_LIMIT, limit) : limit;

    const [entityPage, documentPage] = await Promise.all([
      this.graphRead.listEntities(ctx.user, { q: args.query, sort: 'updated', limit: entityLimit }),
      this.searchDocuments(ctx, args.query, documentLimit),
    ]);

    const entities = entityPage.items.filter((e) => typeVisible(e.type, ctx.personalFactsAllowed)).map((e) => ({
      ref: ctx.handles.register({ kind: 'ent', id: e.id, label: e.label }),
      type: e.type,
      label: e.label,
      aliases: e.aliases,
    }));

    const dates = await this.documentDates(ctx.user.id, documentPage.results);
    const documents = documentPage.results.map((r) => {
      const withStart = r.snippets.find((s) => s.startMs !== null);
      const first = withStart ?? r.snippets[0];
      const startMs = withStart?.startMs ?? null;
      const kind = r.type as 'transcript' | 'note';
      return {
        ref: ctx.handles.register({ kind: 'doc', id: r.id, label: r.title, documentKind: kind, startMs }),
        kind,
        title: r.title,
        excerpt: first ? clip(snippetToText(first.html), QUOTE_MAX_CHARS) : null,
        at: isoDate(dates.get(`${kind}:${r.id}`) ?? r.updatedAt),
        startMs,
      };
    });

    const data: Record<string, unknown> = { entities, documents };
    if (documentPage.unavailable) data.documentsUnavailable = documentPage.unavailable;

    return {
      data,
      resultCount: entities.length + documents.length,
      summary: `Searched "${clip(args.query, 60)}" · ${plural(entities.length, 'entity', 'entities')}, ${plural(documents.length, 'passage', 'passages')}`,
      truncated: documentPage.truncated,
    };
  }

  /**
   * The document leg. A caller holding neither `transcripts:read` nor
   * `notes:read` gets `SearchService`'s one 403 — an empty leg with a reason
   * here, never a failed tool call.
   */
  private async searchDocuments(ctx: AskToolContext, q: string, limit: number) {
    try {
      // The search slice reads a normalised principal (an id and a permission set), not the request user.
      const res = await this.search.search(
        { q, types: 'transcript,note', limit },
        { userId: ctx.user.id, permissions: new Set(ctx.user.permissions) },
      );
      return { results: res.results, truncated: res.nextCursor !== null, unavailable: null as string | null };
    } catch (err) {
      if (err instanceof ForbiddenException) {
        return { results: [], truncated: false, unavailable: 'You do not have permission to search transcripts or notes.' };
      }
      throw err;
    }
  }

  /**
   * The date a passage is FROM — a transcript's recording date, a note's
   * creation date — for the documents the search leg already found visible.
   * Re-scoped here anyway (owned, or shared with the caller; not deleted).
   */
  private async documentDates(
    userId: string,
    results: readonly { type: string; id: string }[],
  ): Promise<Map<string, Date>> {
    const ids = (kind: string) => results.filter((r) => r.type === kind).map((r) => r.id);
    const transcriptIds = ids('transcript');
    const [transcripts, notes] = await Promise.all([
      transcriptIds.length ? this.transcriptDates(userId, transcriptIds) : [],
      ids('note').length
        ? this.prisma.note.findMany({
            where: { id: { in: ids('note') }, ownerId: userId, deletedAt: null },
            select: { id: true, createdAt: true },
          })
        : [],
    ]);
    return new Map<string, Date>([
      ...transcripts.map((t) => [`transcript:${t.id}`, t.recordedAt] as [string, Date]),
      ...notes.map((n) => [`note:${n.id}`, n.createdAt] as [string, Date]),
    ]);
  }

  /** Recording dates of the transcripts the caller may see (theirs, or shared with them by the host's rule; live). */
  private async transcriptDates(userId: string, ids: readonly string[]): Promise<{ id: string; recordedAt: Date }[]> {
    const viewer = await this.visibility.viewerFor(userId);

    return this.visibility.run(viewer, (tx) =>
      tx.$queryRaw<{ id: string; recordedAt: Date }[]>(Prisma.sql`
        SELECT t.id::text AS id, t.recorded_at AS "recordedAt"
          FROM transcripts t
         WHERE t.id = ANY(${[...ids]}::uuid[]) AND ${this.visibility.transcriptVisibleSql(viewer, 't')}`),
    );
  }
}
