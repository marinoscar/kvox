// =============================================================================
// NoteGenerationRequestService (issue #53, epic #45)
// =============================================================================
//
// The three request-time decisions every generation request makes, in ONE
// place: which source, which model, and does the assembled prompt fit.
//
// -----------------------------------------------------------------------------
// WHY THIS FILE EXISTS AT ALL
// -----------------------------------------------------------------------------
//
// `POST /api/notes` (#53) and `POST /api/note-templates/preview` (#50) are two
// entry points into ONE generation mechanism — that is the property
// `note-template-preview.service.ts`'s header spends most of its length
// defending, and `test/notes/note-template-preview-prompt.spec.ts` pins it: the
// bytes `note.generate` sends for a preview are identical to the bytes it sends
// for a real note. Two copies of "may this caller read that transcript", "which
// model is permitted", and "does this fit in the context window" would be two
// copies that agree today and disagree the first time one of them is fixed.
//
// So the preview service delegates here, and so does `NotesService`. Neither
// owns the decisions; both make the same ones.
//
// -----------------------------------------------------------------------------
// THE THREE ANSWERS `resolveModel` CAN GIVE, AND WHY THEY ARE THREE
// -----------------------------------------------------------------------------
//
// They have three different fixes and three different people to talk to — the
// argument `AiConfigService` makes for keeping `available` and `keyConfigured`
// separate, applied to the refusal:
//
//   • the DEPLOYMENT has not enabled AI, or permits no model this build can
//     budget → **409**. The request was well formed; the deployment is not
//     ready. The same posture `POST /api/transcripts`' 409 takes.
//   • the CALLER has no API key → **409**, with a different sentence and a
//     different `details.reason`. Still "not ready", but the person who fixes
//     it is the caller, and a UI that cannot tell the two apart shows the wrong
//     one of "ask your administrator" / "paste your key".
//   • the requested model is not permitted → **400**, naming the permitted
//     list. That one IS the caller's input.
//
// ⚠ THE REASON TRAVELS IN `details`, NOT IN THE TOP-LEVEL `code`. The global
// `HttpExceptionFilter` derives `code` from the status and deliberately ignores
// any `code` an exception supplies — see `dto/note.dto.ts`'s
// `NOTE_CONFLICT_REASONS` for the full argument and the published contract that
// makes it so.
//
// -----------------------------------------------------------------------------
// EVERY SOURCE REFUSAL IS A 404 (spec §6.1)
// -----------------------------------------------------------------------------
//
// A transcript goes through `TranscriptAccessService`, a note through
// `NoteAccessService`, and a document is checked here against
// `uploadedById` + `managed_by: 'notes'`. All three answer 404 for both "gone"
// and "not yours" in their own words — confirming that a private row exists to
// somebody with no access to it is the leak the 404 exists to close.
//
// A source check that ran only inside the job would be worse than absent: the
// job has NO CALLER, so it cannot decide whether THIS user may read the
// transcript they named, and a generation that skipped the check would be a way
// to read any transcript in the deployment by making a note out of it.
// =============================================================================

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AiBudgetError } from '../../ai/ai-errors';
import {
  modelKnowledgeOf,
  resolveAllowedModel,
} from '../../ai/ai-model-resolution';
import type { AiAllowedModel } from '../../ai/ai-settings.schema';
import {
  AiTaskModelResolver,
  type GenerationRefusalMessages,
} from '../../ai/ai-task-model-resolver.service';
import type { AiProvider } from '../../ai/providers/ai-provider.interface';
import type { SystemAiValue } from '../../common/schemas/settings.schema';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptAccessService } from '../../transcripts/transcript-access.service';
import { NoteAccessService } from '../access/note-access.service';
import type { NoteSourceDto } from '../dto/note.dto';
import { NOTES_MANAGED_BY } from '../job-types';
import { assertWithinBudget, computeTokenBudget } from './token-budget';
import type { SourceSelector } from './note-source.service';

/** Which of the two entry points is asking. Shapes the refusal sentences only. */
export type GenerationIntent = 'note' | 'preview';

/**
 * The two 409 sentences for each intent. `ai_not_configured`/`ai_key_missing`
 * are the same `details.reason` strings `NOTE_CONFLICT_REASONS` publishes.
 */
function refusalMessagesFor(intent: GenerationIntent): GenerationRefusalMessages {
  return {
    notConfigured:
      'AI features are not configured for this deployment, so ' +
      (intent === 'preview'
        ? 'a template cannot be previewed. '
        : 'a note cannot be generated. ') +
      'An administrator can enable them in system settings.',
    keyMissing:
      'You have not saved an AI API key. ' +
      (intent === 'preview'
        ? 'A preview is a real generation on your own provider account, so it needs your key. '
        : 'A note is generated on your own provider account, so it needs your key. ') +
      'Add one in your settings and try again.',
  };
}

/** The provider, model and policy one generation will run under. */
export interface ResolvedModel {
  provider: AiProvider<never>;
  model: string;
  policy: SystemAiValue;
}

/** What the budget check needs. All of it is already resolved by the caller. */
export interface PromptFitInput {
  provider: AiProvider<never>;
  model: string;
  policy: SystemAiValue;
  systemPrompt: string;
  userContent: string;
}

@Injectable()
export class NoteGenerationRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskModels: AiTaskModelResolver,
    private readonly transcriptAccess: TranscriptAccessService,
    private readonly noteAccess: NoteAccessService,
  ) {}

  /**
   * Which provider and model this generation runs on, or a refusal that says
   * which of the three things is missing. See the header.
   */
  async resolveModel(
    userId: string,
    requested: string | null,
    intent: GenerationIntent = 'note',
  ): Promise<ResolvedModel> {
    // #360: the checks, their order, the 400 wording and the 409 reasons now
    // live in `AiTaskModelResolver.resolveForGeneration`, shared with every
    // connected-knowledge task. Only the SENTENCES are this caller's.
    const r = await this.taskModels.resolveForGeneration(
      userId,
      requested,
      refusalMessagesFor(intent),
    );

    return { provider: r.provider, model: r.model, policy: r.policy };
  }

  /**
   * The source, checked against THIS caller, as the four denormalized columns
   * `notes` and `note_generations` both carry.
   */
  async resolveSource(source: NoteSourceDto, user: RequestUser): Promise<SourceSelector> {
    if (source.type === 'transcript') {
      await this.transcriptAccess.require(
        user.id,
        source.transcriptId,
        'view',
        user.permissions,
      );

      return {
        sourceType: 'transcript',
        sourceTranscriptId: source.transcriptId,
        sourceNoteId: null,
        sourceObjectId: null,
      };
    }

    if (source.type === 'note') {
      // ⚠ THROUGH `NoteAccessService`, which is the whole reason it exists as a
      // service rather than as an `ownerId` comparison written out here. Its
      // 404 is the same 404 every other note route answers.
      await this.noteAccess.require(user.id, source.noteId, 'view', user.permissions);

      return {
        sourceType: 'note',
        sourceTranscriptId: null,
        sourceNoteId: source.noteId,
        sourceObjectId: null,
      };
    }

    const object = await this.prisma.storageObject.findFirst({
      where: {
        id: source.objectId,
        uploadedById: user.id,
        managedBy: NOTES_MANAGED_BY,
      },
      select: { id: true },
    });

    if (!object) throw new NotFoundException('Document not found');

    return {
      sourceType: 'document',
      sourceTranscriptId: null,
      sourceNoteId: null,
      sourceObjectId: source.objectId,
    };
  }

  /**
   * Refuse early, with a number (spec §3.3).
   *
   * ⚠ NOT A DUPLICATE OF THE JOB'S OWN CHECK, and not redundant with it: a
   * budget refusal discovered in the job is a `failed` generation the user has
   * to go and look at; discovered here it is a 400 with the numbers in it, and
   * nothing was created. The job re-checks against CURRENT state anyway,
   * because a transcript can grow between this request and that claim.
   *
   * A model NOTHING can describe is still not refused here — there is no
   * context window to check against, and `resolveModel` has already established
   * the model is permitted. The job's own check is the backstop. ⚠ SINCE #97
   * THAT FALL-THROUGH IS NEARLY UNREACHABLE: `modelKnowledgeOf` carries the
   * provider's family derivation and its conservative floor as well as its
   * catalogue, so a permitted model almost always HAS a window to check
   * against here. The branch is kept because the one case it was written for —
   * a policy naming a provider this build does not implement — is still real,
   * and because refusing a generation for want of a number nobody can supply
   * would be worse than letting the job report it.
   *
   * ⚠ THE DESCRIPTOR COMES FROM THE POLICY ENTRY, NOT STRAIGHT FROM THE BUILD
   * CATALOGUE (#78). An entry may carry its own `contextWindowTokens`, and such
   * a model — one this build has never heard of, adopted from the discovery
   * dropdown — is exactly the case that used to fall through the `return`
   * below. Falling through means an over-long prompt is not refused HERE with
   * numbers in a 400, but minutes later as a `failed` note the user has to go
   * and look at. `resolveAllowedModel` is the same function the config probe
   * and the job use, so all three agree about what this model's window is.
   */
  assertPromptFits(input: PromptFitInput): void {
    const block = (
      input.policy.providers as Record<
        string,
        { allowedModels?: AiAllowedModel[] } | undefined
      >
    )[input.provider.id];

    const entry = block?.allowedModels?.find(
      (model) => model.id === input.model,
    );

    const descriptor = entry
      ? resolveAllowedModel(entry, modelKnowledgeOf(input.provider))
      : null;

    if (!descriptor) return;

    const budget = computeTokenBudget({
      contextWindowTokens: descriptor.contextWindowTokens,
      modelMaxOutputTokens: descriptor.maxOutputTokens,
      policyMaxOutputTokens: input.policy.maxOutputTokens,
      policyMaxInputTokens: input.policy.maxInputTokens,
    });

    try {
      assertWithinBudget({
        promptTokens: input.provider.countTokens(
          `${input.systemPrompt}\n${input.userContent}`,
          input.model,
        ),
        availableInputTokens: budget.availableInputTokens,
        model: input.model,
        providerId: input.provider.id,
      });
    } catch (error) {
      // ⚠ THE SAME SENTENCE THE JOB WOULD HAVE WRITTEN ONTO THE GENERATION,
      // delivered as a 400 instead. `budgetRefusalMessage` is shared for exactly
      // this reason: the failure is identical and the two surfaces differ only
      // in how it is delivered.
      if (error instanceof AiBudgetError) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }
}
