import { NOTE_CONFLICT_REASONS } from '../dto/note.dto';
import { AI_CONFLICT_REASONS } from '../../ai/ai-task-model-resolver.service';
import {
  GENERATION_CASES,
  outcomeOf,
  policy,
  provider,
  setup,
} from '../../../test/helpers/ai-task-model.fixtures';
import { NoteGenerationRequestService } from './note-generation-request.service';

// =============================================================================
// NoteGenerationRequestService.resolveModel ≡ AiTaskModelResolver.resolveForGeneration
// (issue #360; moved here from `src/ai/ai-task-model-resolver.service.spec.ts`
// by #459)
// =============================================================================
//
// `AiTaskModelResolver.resolveForGeneration` reproduces `resolveModel`'s
// outcomes exactly, and one table (`GENERATION_CASES`) drives both so the
// extraction is proven to have changed no note-generation response. The
// resolver half stays in `src/ai/` (base code); this half needs
// `NoteGenerationRequestService` and `NOTE_CONFLICT_REASONS`, which are notes
// code, so it lives beside them. The fixtures are shared through
// `test/helpers/ai-task-model.fixtures.ts`.
// =============================================================================

describe('AI_CONFLICT_REASONS vs the notes DTO', () => {
  it('shares ai_not_configured / ai_key_missing with NOTE_CONFLICT_REASONS, which the notes path relies on', () => {
    expect(AI_CONFLICT_REASONS.AI_NOT_CONFIGURED).toBe(NOTE_CONFLICT_REASONS.AI_NOT_CONFIGURED);
    expect(AI_CONFLICT_REASONS.AI_KEY_MISSING).toBe(NOTE_CONFLICT_REASONS.AI_KEY_MISSING);
  });
});

describe.each(GENERATION_CASES)('resolveForGeneration ≡ resolveModel: $name', (c) => {
  it('NoteGenerationRequestService.resolveModel gives the outcome the shared table specifies', async () => {
    const { resolver } = setup({
      config: c.config,
      registered: c.registered,
      policy: policy({ graphEnabled: false }),
    });
    const notes = new NoteGenerationRequestService(
      {} as never, // PrismaService
      resolver,
      {} as never, // TranscriptAccessService
      {} as never, // NoteAccessService
      {} as never, // KvoxManagedObjectsService
    );

    const outcome = await outcomeOf(notes.resolveModel('u1', c.requested, c.intent));

    expect(outcome).toEqual(c.expected);
  });
});

describe('NoteGenerationRequestService.resolveModel — the resolution it returns', () => {
  it('returns exactly { provider, model, policy }', async () => {
    const p = policy();
    const { resolver } = setup({ policy: p });
    const notes = new NoteGenerationRequestService(
      {} as never,
      resolver,
      {} as never,
      {} as never,
      {} as never,
    );

    expect(await notes.resolveModel('u1', null)).toEqual({
      provider,
      model: 'gpt-5.4-mini',
      policy: p,
    });
  });
});
