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

import { assertWithinBudget } from '../../core/index.js';
import {
  KVOX_AI,
  KVOX_OBJECT_STORE,
  KVOX_SETTINGS,
  KvoxAiBudgetError,
  KvoxAiError,
  type KvoxAiPort,
  type KvoxAiTarget,
  type KvoxObjectStorePort,
  type KvoxSettingsPort,
} from '../../ports/index.js';
import { TranscriptAccessService } from '../../transcripts/index.js';
import { NoteAccessService } from '../access/note-access.service.js';
import type { NoteSourceDto } from '../dto/note.dto.js';
import { NOTES_MANAGED_BY } from '../job-types.js';
import type { NotesActor } from '../notes-actor.js';
import {
  NOTE_GENERATE_AI_FEATURE,
  NoteAiConflict,
  budgetFromTarget,
  notPermittedBadRequest,
  readAiTokenCaps,
  type AiTokenCaps,
} from './ai-support.js';
import type { SourceSelector } from './note-source.service.js';

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
  /** What `KVOX_AI.resolveTask` answered: the model's own window and output ceiling. */
  target: KvoxAiTarget;
  /** The deployment's spend caps (`ai.maxInputTokens`, `ai.maxOutputTokens`). */
  caps: AiTokenCaps;
}

/** What the budget check needs. All of it is already resolved by the caller. */
export interface PromptFitInput {
  providerId: string;
  model: string;
  target: KvoxAiTarget;
  caps: AiTokenCaps;
  systemPrompt: string;
  userContent: string;
}

/**
 * NoteGenerationRequestService: wiring the slice registers itself; a host configures it through `NotesModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class NoteGenerationRequestService {
  constructor(
    @Inject(KVOX_AI) private readonly ai: KvoxAiPort,
    @Inject(KVOX_SETTINGS) private readonly settings: KvoxSettingsPort,
    @Inject(KVOX_OBJECT_STORE) private readonly store: KvoxObjectStorePort,
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
    let target: KvoxAiTarget;

    try {
      // The checks, their order and the refusal reasons are the AI port's, shared with every
      // other task of the product. Only the SENTENCES are this caller's.
      target = await this.ai.resolveTask(
        { userId, orgId: null, feature: NOTE_GENERATE_AI_FEATURE },
        NOTE_GENERATE_AI_FEATURE,
        requested ? { model: requested } : undefined,
      );
    } catch (error) {
      throw this.refusal(error, requested, refusalMessagesFor(intent));
    }

    return {
      providerId: target.provider,
      model: target.model,
      target,
      caps: await readAiTokenCaps(this.settings),
    };
  }

  /** The refusal one failed resolution becomes. */
  private refusal(error: unknown, requested: string | null, messages: GenerationRefusalMessages): unknown {
    if (!(error instanceof KvoxAiError)) return error;

    switch (error.errorClass) {
      case 'key_missing':
        return new NoteAiConflict('ai_key_missing', messages.keyMissing);
      case 'capability':
        // A model the caller picked that the deployment does not permit is the CALLER's input
        // (a 400); a deployment default no model can serve is the deployment's (a 409).
        return requested !== null
          ? notPermittedBadRequest(requested)
          : new NoteAiConflict(
              'model_lacks_capability',
              'The deployment\'s default model cannot be used to generate a note.',
            );
      default:
        // `not_configured`, or a not-ready answer that names no class.
        return new NoteAiConflict('ai_not_configured', messages.notConfigured);
    }
  }

  /**
   * The source, checked against THIS caller, as the four denormalized columns
   * `notes` and `note_generations` both carry.
   */
  async resolveSource(source: NoteSourceDto, user: NotesActor): Promise<SourceSelector> {
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

    const object = (await this.store.describe([source.objectId])).get(source.objectId);

    if (!object || object.ownerId !== user.id || object.managedBy !== NOTES_MANAGED_BY) {
      throw new NotFoundException('Document not found');
    }

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
   * model before the provider is touched.
   */
  assertPromptFits(input: PromptFitInput): void {
    const budget = budgetFromTarget(input.target, input.caps);

    if (!budget) return;

    try {
      assertWithinBudget({
        promptTokens: this.ai.countTokens(input.target, `${input.systemPrompt}\n${input.userContent}`),
        availableInputTokens: budget.availableInputTokens,
        model: input.model,
      });
    } catch (error) {
      // ⚠ THE SAME SENTENCE THE JOB WOULD HAVE WRITTEN ONTO THE GENERATION,
      // delivered as a 400 instead. `budgetRefusalMessage` is shared for exactly
      // this reason: the failure is identical and the two surfaces differ only
      // in how it is delivered.
      if (error instanceof KvoxAiBudgetError) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }
}
