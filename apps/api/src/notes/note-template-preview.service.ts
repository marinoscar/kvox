import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AiBudgetError } from '../ai/ai-errors';
import { AiConfigService } from '../ai/ai-config.service';
import { AiProviderRegistry } from '../ai/ai-provider.registry';
import { AiSettingsService } from '../ai/ai-settings.service';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { TranscriptAccessService } from '../transcripts/transcript-access.service';
import { NoteTemplateAccessService } from './access/note-template-access.service';
import { NoteSourceService } from './generation/note-source.service';
import { assemblePrompt, parseTemplateStructure } from './generation/prompt';
import { assertWithinBudget, computeTokenBudget } from './generation/token-budget';
import { NOTE_GENERATE_JOB_TYPE, NOTE_SUBJECT_TYPE } from './job-types';
import { assertInstructionsFit } from './note-templates.service';
import type {
  PreviewNoteTemplateDto,
  PreviewNoteTemplateResponse,
  PreviewSourceDto,
} from './dto/note-template.dto';
import type { PayloadTemplateSnapshot } from './generation/note-generation.service';

// =============================================================================
// NoteTemplatePreviewService (issue #50, epic #45)
// =============================================================================
//
// `POST /api/note-templates/preview` — try a template, saved or unsaved,
// against a real source, before trusting it with a real note.
//
// -----------------------------------------------------------------------------
// ⚠ ONE GENERATION MECHANISM, TWO ENTRY POINTS. THIS FILE IS THE SECOND ENTRY
//   POINT AND NOTHING ELSE.
// -----------------------------------------------------------------------------
//
// A preview creates a `note_generations` row (`kind: 'preview'`, `note_id:
// NULL`, `expires_at` a few minutes out) and enqueues **the same
// `note.generate` job** a real note does. It does not call a provider, it does
// not assemble a prompt for sending, it does not stream, and it does not have
// an error taxonomy of its own.
//
// The alternative — a preview path that called the provider synchronously — was
// rejected twice over in issue #50 and it is worth having the reasons here,
// beside the code that would otherwise grow into it:
//
//   • it is the same long-running work as a real generation, so CLAUDE.md's
//     queue rule applies to it identically; and
//   • it would fork prompt assembly, the token budget and the error taxonomy
//     into a SECOND implementation, which would then drift from the real one
//     exactly when it mattered — a user would tune a template against preview
//     output and find the real note came out differently.
//
// `test/notes/note-template-preview-prompt.spec.ts` pins the consequence: the
// bytes `note.generate` sends for a preview of an unsaved template are
// identical to the bytes it sends for a real generation from the saved one.
//
// -----------------------------------------------------------------------------
// HOW AN UNSAVED TEMPLATE REACHES THE JOB WITHOUT A ROW TO READ IT FROM
// -----------------------------------------------------------------------------
//
// Through the JOB PAYLOAD, following the seam `readPayloadUserId` already
// established in `note-generation.service.ts` for exactly this issue ("keeps
// the preview issue to 'enqueue with `userId`' rather than a schema change").
// `note_generations` has columns for the generation's inputs but NOT for the
// five template columns, so an inline body has nowhere else to live.
//
// ⚠ AND ONLY WHEN IT IS UNSAVED. A preview OF A SAVED TEMPLATE sets
// `template_id` and carries no snapshot at all, so the job reads the row the
// ordinary way and the two paths are the same code, not two codes that agree.
// The handler's rule is `templateId ? the row : the payload`, never a merge.
//
// -----------------------------------------------------------------------------
// THE REQUEST-TIME CHECKS, AND WHY THEY ARE HERE RATHER THAN ONLY IN THE JOB
// -----------------------------------------------------------------------------
//
// Access to the SOURCE, and the token budget, are both checked synchronously,
// before anything is created — spec §3.3's "refuse early with a number", and
// §6.1's 404 posture. Neither is a duplicate of the job's own check:
//
//   • the job has no caller, so it cannot decide whether THIS user may read the
//     transcript they named. That decision can only be made here, and a preview
//     that skipped it would be a way to read any transcript in the deployment
//     by generating a note from it;
//   • a budget refusal discovered in the job is a `failed` generation the user
//     has to go and look at; discovered here it is a 400 with the numbers in
//     it, and nothing was created.
//
// The job re-checks the budget against CURRENT state anyway (§3.3), which is
// not redundant: a transcript can grow between this request and that claim.
// =============================================================================

/**
 * How long a preview generation survives before `notes.housekeeping` hard-
 * deletes it (spec §4.4).
 *
 * Ten minutes: comfortably longer than the generation itself (`note.generate`
 * is bounded at ten minutes of RUNTIME, and a preview is a short note against
 * one source), and short enough that a disposable row stays disposable. There
 * is nothing to lose by it expiring — a preview has no note, no version and
 * nothing referencing it; the user presses the button again.
 */
export const PREVIEW_TTL_MS = 10 * 60 * 1000;

/** The template fields one preview generates from, however they were supplied. */
interface ResolvedPreviewTemplate {
  /** The saved template's id, or `null` for an inline body. */
  templateId: string | null;
  name: string;
  fields: PayloadTemplateSnapshot;
  /** The template's own `model` override, when it has one. */
  model: string | null;
}

@Injectable()
export class NoteTemplatePreviewService {
  private readonly logger = new Logger(NoteTemplatePreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NoteTemplateAccessService,
    private readonly transcriptAccess: TranscriptAccessService,
    private readonly aiConfig: AiConfigService,
    private readonly aiSettings: AiSettingsService,
    private readonly providers: AiProviderRegistry,
    private readonly sources: NoteSourceService,
    private readonly jobs: JobsService,
  ) {}

  async preview(
    dto: PreviewNoteTemplateDto,
    user: RequestUser,
  ): Promise<PreviewNoteTemplateResponse> {
    const template = await this.resolveTemplate(dto, user.id);

    // The source, and whether this caller may read it. BEFORE anything is
    // created — see the header on why this check cannot be deferred to the job.
    const selector = await this.resolveSource(dto.source, user);

    const { provider, model, policy } = await this.resolveModel(
      user.id,
      dto.model ?? template.model ?? null,
    );

    const contextText = dto.contextText?.trim() ? dto.contextText.trim() : null;

    // -------------------------------------------------------------------------
    // Assemble and budget, with THE SAME pure function `note.generate` calls.
    // -------------------------------------------------------------------------
    const source = await this.sources.resolve(selector);

    const prompt = assemblePrompt({
      templateInstructions: template.fields.instructions,
      templateOutputFormat: template.fields.outputFormat,
      templateStructure: parseTemplateStructure(template.fields.structure),
      templateTone: template.fields.tone,
      templateLength: template.fields.length,
      contextText,
      sourceText: source.text,
    });

    const descriptor = provider.capabilities.models.find((entry) => entry.id === model);

    if (descriptor) {
      const budget = computeTokenBudget({
        contextWindowTokens: descriptor.contextWindowTokens,
        modelMaxOutputTokens: descriptor.maxOutputTokens,
        policyMaxOutputTokens: policy.maxOutputTokens,
        policyMaxInputTokens: policy.maxInputTokens,
      });

      try {
        assertWithinBudget({
          promptTokens: provider.countTokens(
            `${prompt.systemPrompt}\n${prompt.userContent}`,
            model,
          ),
          availableInputTokens: budget.availableInputTokens,
          model,
          providerId: provider.id,
        });
      } catch (error) {
        // ⚠ THE SAME SENTENCE THE JOB WOULD HAVE WRITTEN ONTO THE GENERATION,
        // delivered as a 400 instead. `budgetRefusalMessage` is shared for
        // exactly this reason: the failure is identical and the two surfaces
        // differ only in how it is delivered.
        if (error instanceof AiBudgetError) {
          throw new BadRequestException(error.message);
        }

        throw error;
      }
    }

    // -------------------------------------------------------------------------
    // Create the row and queue the job, together.
    // -------------------------------------------------------------------------
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);

    // ⚠ THE SNAPSHOT TRAVELS ONLY FOR AN UNSAVED BODY. See the header.
    const payloadTemplate = template.templateId === null ? template.fields : undefined;

    const { generation, jobId } = await this.prisma.$transaction(async (tx) => {
      const generation = await tx.noteGeneration.create({
        data: {
          // ⚠ `noteId: null` IS THE DEFINITION OF A PREVIEW. No note is created
          // here, none is created by the job, and nothing in `GET /api/notes`
          // can ever see this row — a note list reads `notes`, and this row is
          // attached to nothing in it.
          noteId: null,
          kind: 'preview',
          status: 'pending',
          templateId: template.templateId,
          templateNameSnapshot: template.name,
          contextText,
          sourceType: selector.sourceType,
          sourceTranscriptId: selector.sourceTranscriptId,
          sourceNoteId: selector.sourceNoteId,
          sourceObjectId: selector.sourceObjectId,
          providerId: provider.id,
          model,
          expiresAt,
        },
      });

      const job = await this.jobs.enqueueWithin(tx, {
        type: NOTE_GENERATE_JOB_TYPE,
        reason: 'rerun',
        subjectType: NOTE_SUBJECT_TYPE,
        subjectId: generation.id,
        payload: {
          generationId: generation.id,
          // The generation row has no user column of its own and no note to
          // read an owner from, so the payload is where the billed account
          // travels — the seam `readPayloadUserId` was written for.
          userId: user.id,
          // ⚠ `{ ...snapshot }` RATHER THAN THE OBJECT ITSELF, because Prisma's
          // `InputJsonObject` demands an index signature a named interface does
          // not have. Spreading produces the structurally-identical anonymous
          // object literal, which does. `readPayloadTemplate` reads it back.
          ...(payloadTemplate ? { template: { ...payloadTemplate } } : {}),
        } satisfies Prisma.InputJsonObject,
        // ⚠ `skipDedup` BECAUSE TWO PREVIEWS ARE TWO PIECES OF WORK. They are
        // deliberately distinct: the user changed the instructions and pressed
        // the button again, which is the entire flow. Without this the second
        // request would silently return the first job and the user would watch
        // their OLD template generate.
        skipDedup: true,
      });

      await tx.noteGeneration.update({
        where: { id: generation.id },
        data: { jobId: job.id },
      });

      return { generation, jobId: job.id };
    });

    this.logger.log(
      `Preview generation ${generation.id} queued for user ${user.id} from ${source.describe} ` +
        `(${template.templateId ? `template ${template.templateId}` : 'an unsaved template'})`,
    );

    return {
      generationId: generation.id,
      kind: 'preview',
      status: 'pending',
      jobId,
      templateId: template.templateId,
      templateName: template.name,
      providerId: provider.id,
      model,
      expiresAt: expiresAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /**
   * The template being previewed — a saved row, or the inline body.
   *
   * The saved path goes through `access.require(..., 'read')`, so previewing a
   * BUILT-IN works (that is most of what previewing is for) and previewing
   * somebody else's is a 404, exactly as reading it would be. A preview must
   * not become a way to read a template you cannot read.
   */
  private async resolveTemplate(
    dto: PreviewNoteTemplateDto,
    userId: string,
  ): Promise<ResolvedPreviewTemplate> {
    if (dto.templateId) {
      const { template } = await this.access.require(userId, dto.templateId, 'read');

      return {
        templateId: template.id,
        name: template.name,
        fields: {
          instructions: template.instructions,
          outputFormat: template.outputFormat,
          structure: parseTemplateStructure(template.structure),
          tone: template.tone,
          length: template.length,
        },
        model: template.model,
      };
    }

    // The schema's refinement guarantees one of the two is present.
    const inline = dto.template!;

    // The same ceiling a saved template is held to — an unsaved body is not a
    // way around it, and the request is about to become a real generation.
    assertInstructionsFit(inline.instructions);

    return {
      templateId: null,
      name: inline.name,
      fields: {
        instructions: inline.instructions,
        outputFormat: inline.outputFormat,
        structure: inline.structure,
        tone: inline.tone,
        length: inline.length,
      },
      model: inline.model,
    };
  }

  /**
   * The source, checked against THIS caller, as the four denormalized columns.
   *
   * ⚠ EVERY REFUSAL IS A 404 (spec §6.1). A transcript goes through
   * `TranscriptAccessService`, which already answers 404 for both "gone" and
   * "not yours" in the same words. A source note and a source document are
   * checked here, owner-only, with the same posture — they are private rows and
   * confirming one exists to somebody with no access to it is the leak the 404
   * exists to close.
   *
   * There is no `NoteAccessService` yet (#53 owns it, spec §6.1). When it
   * lands, the `note` branch becomes a call to it and nothing else here moves.
   */
  private async resolveSource(source: PreviewSourceDto, user: RequestUser) {
    if (source.type === 'transcript') {
      await this.transcriptAccess.require(
        user.id,
        source.transcriptId,
        'view',
        user.permissions,
      );

      return {
        sourceType: 'transcript' as const,
        sourceTranscriptId: source.transcriptId,
        sourceNoteId: null,
        sourceObjectId: null,
      };
    }

    if (source.type === 'note') {
      const note = await this.prisma.note.findFirst({
        where: { id: source.noteId, ownerId: user.id, deletedAt: null },
        select: { id: true },
      });

      if (!note) throw new NotFoundException('Note not found');

      return {
        sourceType: 'note' as const,
        sourceTranscriptId: null,
        sourceNoteId: source.noteId,
        sourceObjectId: null,
      };
    }

    const object = await this.prisma.storageObject.findFirst({
      where: { id: source.objectId, uploadedById: user.id, managedBy: 'notes' },
      select: { id: true },
    });

    if (!object) throw new NotFoundException('Document not found');

    return {
      sourceType: 'document' as const,
      sourceTranscriptId: null,
      sourceNoteId: null,
      sourceObjectId: source.objectId,
    };
  }

  /**
   * Which provider and model this preview runs on, or a refusal that says which
   * of the three things is missing.
   *
   * THREE DISTINCT ANSWERS, because they have three different fixes and three
   * different people to talk to (the argument `AiConfigService` makes for
   * keeping `available` and `keyConfigured` separate, applied to the refusal):
   *
   *   • the deployment has not enabled AI, or permits no model this build can
   *     budget → **409**. The request was well formed; the deployment is not
   *     ready. Same posture as `POST /api/transcripts`' 409.
   *   • the CALLER has no API key → **409**, with a different sentence. It is
   *     still "not ready", but the person who fixes it is the caller.
   *   • the requested model is not permitted → **400**, naming the permitted
   *     list. That one IS the caller's input.
   */
  private async resolveModel(userId: string, requested: string | null) {
    const config = await this.aiConfig.getConfig(userId);

    if (!config.available || !config.provider) {
      throw new ConflictException(
        'AI features are not configured for this deployment, so a template cannot be previewed. ' +
          'An administrator can enable them in system settings.',
      );
    }

    if (!config.keyConfigured) {
      throw new ConflictException(
        'You have not saved an AI API key. A preview is a real generation on your own provider ' +
          'account, so it needs your key. Add one in your settings and try again.',
      );
    }

    const permitted = config.models.map((entry) => entry.id);
    const model = requested ?? config.defaultModel;

    if (!model || !permitted.includes(model)) {
      throw new BadRequestException(
        `The model "${model ?? 'none'}" is not one this deployment permits. Choose one of: ` +
          `${permitted.join(', ')}.`,
      );
    }

    const provider = this.providers.get(config.provider);

    if (!provider) {
      // `AiConfigService.available` already required the provider to be
      // registered, so this is unreachable in practice; it is a 409 rather than
      // a thrown 500 because "this build does not have that provider" is a
      // deployment state, not a bug in the request.
      throw new ConflictException(
        `This version of the application does not have the "${config.provider}" provider.`,
      );
    }

    const policy = await this.aiSettings.get();

    return { provider, model, policy };
  }
}
