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
// argument the retired `AiConfigService` made for keeping `available` and `keyConfigured`
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
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AiBudgetError } from '../../ai-port/ai-errors';
import { assertWithinBudget } from '../../ai-port/ai-token-budget';
import { KVOX_AI, type KvoxAi, type KvoxAiReadiness } from '../../ai-port/kvox-ai';
import {
  KvoxAiConflict,
  graphDisabledConflict,
  notPermittedBadRequest,
} from '../../ai-port/kvox-ai-errors';
import type { RequestUser } from '@marinoscar/platform-api/identity';
import { KvoxAiSettings } from '../../ai-port/kvox-ai-settings';
import { PrismaService } from '../../prisma/prisma.service';
import { KvoxManagedObjectsService } from '../../kvox-objects/kvox-managed-objects.service';
import { TranscriptAccessService } from '@marinoscar/kvox-api/transcripts';
import { NoteAccessService } from '../access/note-access.service';
import type { NoteSourceDto } from '../dto/note.dto';
import { NOTES_MANAGED_BY } from '../job-types';
import {
  budgetFromReadiness,
  readAiTokenCaps,
  type AiTokenCaps,
} from './ai-readiness';
import type { SourceSelector } from './note-source.service';

/** Which of the two entry points is asking. Shapes the refusal sentences only. */
export type GenerationIntent = 'note' | 'preview';

/** The two 409 sentences a caller supplies; the rest of each refusal is shared. */
interface GenerationRefusalMessages {
  notConfigured: string;
  keyMissing: string;
}

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

/** The provider, model and limits one generation will run under. */
export interface ResolvedModel {
  providerId: string;
  model: string;
  /** What `KvoxAi.readiness` answered: the model's own window and output ceiling. */
  readiness: KvoxAiReadiness;
  /** The deployment's spend caps (`ai.maxInputTokens`, `ai.maxOutputTokens`). */
  caps: AiTokenCaps;
}

/** What the budget check needs. All of it is already resolved by the caller. */
export interface PromptFitInput {
  providerId: string;
  model: string;
  readiness: KvoxAiReadiness;
  caps: AiTokenCaps;
  systemPrompt: string;
  userContent: string;
}

@Injectable()
export class NoteGenerationRequestService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(KVOX_AI) private readonly ai: KvoxAi,
    private readonly settings: KvoxAiSettings,
    private readonly transcriptAccess: TranscriptAccessService,
    private readonly noteAccess: NoteAccessService,
    private readonly managedObjects: KvoxManagedObjectsService,
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
    // #475: the checks, their order and the 409 reasons are `KvoxAi.readiness`'s,
    // shared with every connected-knowledge task. Only the SENTENCES are this
    // caller's.
    const readiness = await this.ai.readiness(userId, 'note_generate', requested);

    if (!readiness.ok || readiness.provider === null || readiness.model === null) {
      throw await this.refusal(readiness, requested, refusalMessagesFor(intent));
    }

    return {
      providerId: readiness.provider,
      model: readiness.model,
      readiness,
      caps: await readAiTokenCaps(this.settings),
    };
  }

  /** The refusal one not-ready answer becomes. */
  private async refusal(
    readiness: KvoxAiReadiness,
    requested: string | null,
    messages: GenerationRefusalMessages,
  ): Promise<Error> {
    switch (readiness.reason) {
      case 'ai_key_missing':
        return new KvoxAiConflict('ai_key_missing', messages.keyMissing);
      case 'model_not_permitted':
        return notPermittedBadRequest({
          model: requested ?? readiness.model,
          permitted: await this.permittedModelIds(),
        });
      case 'model_lacks_capability':
        return new KvoxAiConflict(
          'model_lacks_capability',
          `The model "${readiness.model ?? 'none'}" cannot be used to generate a note.`,
        );
      case 'graph_disabled':
        return graphDisabledConflict();
      default:
        // `ai_not_configured`, or a not-ready answer that names no reason.
        return new KvoxAiConflict('ai_not_configured', messages.notConfigured);
    }
  }

  /** The model ids an administrator has enabled, for the 400's "Choose one of". */
  private async permittedModelIds(): Promise<string[]> {
    try {
      const rows = await this.prisma.aiModel.findMany({
        where: { provider: 'openai', enabled: true },
        orderBy: { modelId: 'asc' },
        select: { modelId: true },
      });

      return rows.map((row) => row.modelId);
    } catch {
      // The list is a courtesy in the message; the refusal stands without it.
      return [];
    }
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

    const object = await this.managedObjects.findFirst({
      where: {
        id: source.objectId,
        uploadedById: user.id,
      },
      select: { id: true },
    });

    const owner = object ? (await this.managedObjects.managedBy([object.id])).get(object.id) : null;
    if (!object || owner !== NOTES_MANAGED_BY) throw new NotFoundException('Document not found');

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
   * A model with NO recorded context window is still not refused here — there
   * is nothing to check against, and `resolveModel` has already established the
   * model is enabled. The job's own check is the backstop, and it refuses such a
   * model before the provider is touched. The window comes from the enabled
   * model's catalogue row (`readiness.contextWindowTokens`), the same number the
   * job and `GET /api/ai-tasks/config` use, so all three agree.
   */
  assertPromptFits(input: PromptFitInput): void {
    // No context window recorded: nothing to check against. The job's own
    // check is the backstop (it refuses a model with no window).
    const budget = budgetFromReadiness(input.readiness, input.caps);

    if (!budget) return;

    try {
      assertWithinBudget({
        promptTokens: this.ai.countTokens(
          `${input.systemPrompt}\n${input.userContent}`,
          input.model,
        ),
        availableInputTokens: budget.availableInputTokens,
        model: input.model,
        providerId: input.providerId,
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
