import { Injectable, NotFoundException } from '@nestjs/common';
import type { NoteGeneration } from '@prisma/client';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { NoteAccessService } from './access/note-access.service';
import type { NoteGenerationContextResponse } from './dto/note.dto';
import { assemblePrompt, CONTEXT_HEADING, parseTemplateStructure, SOURCE_HEADING } from './generation/prompt';
import { NoteSourceNameService } from './note-source-name.service';
import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// What a generation sent to its provider (issue #307)
// =============================================================================
//
// `note.generate` records the exact `assemblePrompt()` output on the
// generation row immediately before the provider call
// (`NoteGenerationService.recordContext`). This service reads it back for
// `GET /api/notes/:id/context` and `GET /api/notes/:id/generations/:gid/context`.
//
// -----------------------------------------------------------------------------
// A ROW WRITTEN BEFORE #307 (`stored: false`) IS NEVER BACKFILLED
// -----------------------------------------------------------------------------
//
// For such a row the system prompt is REBUILT from the template as it stands
// today (when the template still exists) and `userContent` stays `null`. The
// source is never re-materialized: it may have been corrected since, and
// showing today's transcript as "what was sent" would fabricate history.
// `stored: false` is what tells a client the system prompt is a reconstruction.
//
// -----------------------------------------------------------------------------
// ⚠ THE SOURCE MATERIAL IS WITHHELD FROM A CALLER WHO CAN NO LONGER READ IT
// -----------------------------------------------------------------------------
//
// A note can outlive the caller's access to its source — a transcript shared
// with them and later unshared. The stored `userContent` still contains that
// transcript verbatim, so returning it would be a read-around of the unshare.
// "Can read the source" is decided by `NoteSourceNameService` — the exact
// predicate the list and detail routes already use to decide whether a source's
// NAME may be shown — so there is one definition of that reach, not two. When
// redacted, `userContent` is cut at the `Source material:` heading and a
// sentence says why; the user's own Context above it stays.
// =============================================================================

/** The sentence that replaces withheld source material. */
export const SOURCE_WITHHELD_NOTICE =
  '[source material withheld — you no longer have access to this source]';

/** `details.reason` of the 404 for a note that has never had a generation. */
export const NO_GENERATION_REASON = 'no_generation';

@Injectable()
export class NoteGenerationContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NoteAccessService,
    private readonly sourceNames: NoteSourceNameService,
  ) {}

  /**
   * The context of `generationId`, or of the note's current generation when
   * omitted. 404 for no access (never 403), for a generation that is not this
   * note's, and — with `details.reason: 'no_generation'` — for a note with no
   * current generation.
   */
  async forNote(
    user: RequestUser,
    noteId: string,
    generationId?: string,
  ): Promise<NoteGenerationContextResponse> {
    const { note } = await this.access.require(user.id, noteId, 'view', user.permissions);

    const targetId = generationId ?? note.currentGenerationId;

    if (!targetId) {
      throw new NotFoundException({
        message: 'This note has no generation to show the context of.',
        details: { reason: NO_GENERATION_REASON },
      });
    }

    const generation = await this.prisma.noteGeneration.findUnique({ where: { id: targetId } });

    // ⚠ `noteId` MUST MATCH. A generation id belonging to another note (or a
    // preview, whose `noteId` is null) answers the same 404 as a missing one.
    if (!generation || generation.noteId !== note.id) {
      throw new NotFoundException('Note generation not found');
    }

    return this.shape(generation, user.id);
  }

  private async shape(
    generation: NoteGeneration,
    userId: string,
  ): Promise<NoteGenerationContextResponse> {
    const stored = generation.systemPrompt !== null;

    const sourceReadable = (await this.sourceNames.resolveOne(generation, userId)) !== null;
    const sourceRedacted = !sourceReadable;

    const systemPrompt = stored
      ? generation.systemPrompt
      : await this.rebuildSystemPrompt(generation.templateId);

    const userContent =
      stored && generation.userContent !== null && sourceRedacted
        ? redactSourceMaterial(generation.userContent, generation.contextText)
        : generation.userContent;

    return {
      generationId: generation.id,
      kind: generation.kind,
      status: generation.status,
      stored,
      capturedAt: generation.contextCapturedAt?.toISOString() ?? null,
      templateId: generation.templateId,
      templateNameSnapshot: generation.templateNameSnapshot,
      provider: generation.providerId,
      model: generation.model,
      contextText: generation.contextText,
      sourceType: generation.sourceType,
      sourceVersion: generation.sourceVersion,
      sourceRedacted,
      systemPrompt,
      userContent: stored ? userContent : null,
      promptTokens: generation.promptTokens,
      completionTokens: generation.completionTokens,
    };
  }

  /**
   * The system prompt a pre-#307 row's template would assemble TODAY.
   *
   * The system prompt is a function of the template alone (the source and
   * context only ever reach `userContent`), so an empty source is passed and
   * the user half is discarded. `null` when the template is gone.
   */
  private async rebuildSystemPrompt(templateId: string | null): Promise<string | null> {
    if (!templateId) return null;

    const template = await this.prisma.noteTemplate.findUnique({ where: { id: templateId } });
    if (!template) return null;

    return assemblePrompt({
      templateInstructions: template.instructions,
      templateOutputFormat: template.outputFormat,
      templateStructure: parseTemplateStructure(template.structure),
      templateTone: template.tone,
      templateLength: template.length,
      contextText: null,
      sourceText: '',
    }).systemPrompt;
  }
}

/**
 * Cut `userContent` at its `Source material:` heading and append the notice.
 *
 * ⚠ THE CUT POINT IS COMPUTED, NOT SEARCHED FOR. The user's own Context comes
 * first and can itself contain the words "Source material:", so the first
 * occurrence is not necessarily the heading. `assemblePrompt` writes exactly
 * `[<CONTEXT_HEADING>\n<context>\n\n]<SOURCE_HEADING>\n<source>`, so the
 * expected prefix is rebuilt from the row's `contextText`. If the stored text
 * does not start with it (a row assembled by a different build), EVERYTHING
 * after the heading is withheld — failing closed.
 */
export function redactSourceMaterial(userContent: string, contextText: string | null): string {
  const context = typeof contextText === 'string' ? contextText.trim() : '';
  const prefix = context.length > 0 ? `${CONTEXT_HEADING}\n${context}\n\n` : '';

  if (userContent.startsWith(`${prefix}${SOURCE_HEADING}`)) {
    return `${prefix}${SOURCE_HEADING}\n${SOURCE_WITHHELD_NOTICE}`;
  }

  return `${SOURCE_HEADING}\n${SOURCE_WITHHELD_NOTICE}`;
}
