// =============================================================================
// VoiceprintsService (#826): suggestions are the caller's, accept names through the
// transcript editing path, and the voiceprint routes are Person-only.
// =============================================================================

import { ConflictException, NotFoundException } from '@nestjs/common';

import { OP_TYPES } from '../../transcripts/index.js';
import { VOICEPRINTS_DELETED_ALL_ACTION, VOICEPRINT_FORGOTTEN_ACTION, VoiceprintsService } from './voiceprints.service.js';

const USER = { id: '11111111-1111-4111-8111-111111111111', permissions: ['graph:write', 'transcripts:write'] };
const SUGGESTION = '55555555-5555-4555-8555-555555555555';
const SPEAKER = '33333333-3333-4333-8333-333333333331';
const TRANSCRIPT = '22222222-2222-4222-8222-222222222221';
const PERSON = '44444444-4444-4444-8444-444444444441';

function setup(opts: { queries?: unknown[][]; speakers?: unknown[]; identities?: unknown; entityType?: string } = {}) {
  const queue = [...(opts.queries ?? [])];
  const prisma = {
    $queryRaw: jest.fn().mockImplementation(async () => queue.shift() ?? []),
    $executeRaw: jest.fn().mockResolvedValue(2),
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    transcriptSpeaker: {
      findMany: jest.fn().mockResolvedValue(
        opts.speakers ?? [{ id: SPEAKER, label: 'A', displayName: 'Speaker A', rev: 4 }],
      ),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const graphAccess = { require: jest.fn().mockResolvedValue({ id: PERSON, type: opts.entityType ?? 'Person' }) };
  const transcriptAccess = {
    require: jest.fn().mockResolvedValue({
      transcript: { id: TRANSCRIPT, currentVersion: 3, speakerIdentities: opts.identities ?? {} },
    }),
  };
  const editing = { applyOperations: jest.fn().mockResolvedValue({}) };
  const preferences = { get: jest.fn().mockResolvedValue({ voiceprints: { enabled: true, consentAt: '2026-01-01T00:00:00.000Z' } }) };
  const service = new VoiceprintsService(
    prisma as never,
    audit as never,
    graphAccess as never,
    transcriptAccess as never,
    editing as never,
    preferences as never,
  );
  return { service, prisma, audit, graphAccess, transcriptAccess, editing };
}

const pending = { id: SUGGESTION, speaker_id: SPEAKER, transcript_id: TRANSCRIPT, entity_id: PERSON, status: 'pending', decided_at: null };

describe('VoiceprintsService', () => {
  describe('listForTranscript', () => {
    it('maps pending rows of still-unnamed speakers and never returns a vector', async () => {
      const created = new Date('2026-02-01T00:00:00Z');
      const { service } = setup({
        queries: [[{ id: SUGGESTION, speaker_id: SPEAKER, entity_id: PERSON, label: 'Person A', score: 0.8, margin: 0.2, created_at: created }]],
      });
      const out = await service.listForTranscript(TRANSCRIPT, USER);
      expect(out).toEqual([
        { id: SUGGESTION, speakerId: SPEAKER, entityId: PERSON, entityName: 'Person A', score: 0.8, margin: 0.2, createdAt: created.toISOString() },
      ]);
    });

    it('drops a suggestion whose speaker has been named through an identity overlay', async () => {
      const { service } = setup({
        queries: [[{ id: SUGGESTION, speaker_id: SPEAKER, entity_id: PERSON, label: 'Person A', score: 0.8, margin: null, created_at: new Date() }]],
        identities: { [SPEAKER]: 'Someone' },
      });
      expect(await service.listForTranscript(TRANSCRIPT, USER)).toEqual([]);
    });
  });

  describe('accept', () => {
    it('names the speaker with the canonical name through the editing path, then closes the suggestion', async () => {
      const decided = new Date('2026-03-01T00:00:00Z');
      const { service, editing } = setup({ queries: [[pending], [{ label: 'Person A' }], [{ decided_at: decided }]] });
      const out = await service.accept(SUGGESTION, USER);
      expect(editing.applyOperations).toHaveBeenCalledWith(
        TRANSCRIPT,
        expect.objectContaining({
          baseVersion: 3,
          ops: [{ op: OP_TYPES.RENAME_SPEAKER, speakerId: SPEAKER, rev: 4, displayName: 'Person A' }],
        }),
        { id: USER.id, permissions: USER.permissions },
      );
      expect(out).toEqual({ id: SUGGESTION, status: 'accepted', decidedAt: decided.toISOString() });
    });

    it('is idempotent for an accepted row', async () => {
      const { service, editing } = setup({ queries: [[{ ...pending, status: 'accepted', decided_at: new Date() }]] });
      expect((await service.accept(SUGGESTION, USER)).status).toBe('accepted');
      expect(editing.applyOperations).not.toHaveBeenCalled();
    });

    it('answers 409 when the speaker is no longer a placeholder', async () => {
      const { service, editing } = setup({
        queries: [[pending], [{ label: 'Person A' }]],
        speakers: [{ id: SPEAKER, label: 'A', displayName: 'Someone Else', rev: 5 }],
      });
      await expect(service.accept(SUGGESTION, USER)).rejects.toBeInstanceOf(ConflictException);
      expect(editing.applyOperations).not.toHaveBeenCalled();
    });

    it('answers 404 for a suggestion that is not the caller\'s or was dismissed', async () => {
      const a = setup({ queries: [[]] });
      await expect(a.service.accept(SUGGESTION, USER)).rejects.toBeInstanceOf(NotFoundException);
      const b = setup({ queries: [[{ ...pending, status: 'dismissed' }]] });
      await expect(b.service.accept(SUGGESTION, USER)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 when the Person is no longer live', async () => {
      const { service } = setup({ queries: [[pending], []] });
      await expect(service.accept(SUGGESTION, USER)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('dismiss', () => {
    it('requires edit access and closes the suggestion', async () => {
      const { service, transcriptAccess } = setup({ queries: [[pending], [{ decided_at: new Date() }]] });
      expect((await service.dismiss(SUGGESTION, USER)).status).toBe('dismissed');
      expect(transcriptAccess.require).toHaveBeenCalledWith(USER.id, TRANSCRIPT, 'edit', USER.permissions);
    });
  });

  describe('voiceprint of a person', () => {
    it('reads the summary, and is not enrolled without samples', async () => {
      const { service } = setup({ queries: [[{ samples: 0, speech_ms: 0, last_updated: null, model_id: null }]] });
      expect(await service.personVoiceprint(PERSON, USER)).toEqual({
        enrolled: false, samples: 0, speechMs: 0, lastUpdatedAt: null, modelId: null,
      });
    });

    it('reports the samples and model when enrolled', async () => {
      const at = new Date('2026-04-01T00:00:00Z');
      const { service } = setup({ queries: [[{ samples: 2, speech_ms: 90_000, last_updated: at, model_id: 'm-1' }]] });
      expect(await service.personVoiceprint(PERSON, USER)).toEqual({
        enrolled: true, samples: 2, speechMs: 90_000, lastUpdatedAt: at.toISOString(), modelId: 'm-1',
      });
    });

    it('answers 404 for anything that is not a Person', async () => {
      const { service } = setup({ entityType: 'Organization' });
      await expect(service.personVoiceprint(PERSON, USER)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.forgetPerson(PERSON, USER)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forgets a Person: edit access, delete, audit with ids and counts only', async () => {
      const { service, graphAccess, audit, prisma } = setup();
      await service.forgetPerson(PERSON, USER);
      expect(graphAccess.require).toHaveBeenCalledWith(USER.id, 'entity', PERSON, 'edit', USER.permissions);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: VOICEPRINT_FORGOTTEN_ACTION, meta: { entityId: PERSON, samples: 2 } }),
      );
    });
  });

  it('deleteAll returns the counts and audits them', async () => {
    const { service, audit } = setup();
    expect(await service.deleteAll(USER)).toEqual({ deletedSamples: 2, deletedSuggestions: 2 });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: VOICEPRINTS_DELETED_ALL_ACTION, meta: { deletedSamples: 2, deletedSuggestions: 2 } }),
    );
  });

  it('summary combines the preferences and the stored counts', async () => {
    const { service } = setup({ queries: [[{ people: 3, samples: 5 }]] });
    expect(await service.summary(USER)).toEqual({ enabled: true, consentAt: '2026-01-01T00:00:00.000Z', people: 3, samples: 5 });
  });
});
