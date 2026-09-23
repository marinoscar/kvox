// =============================================================================
// Locks down the generated `Note`/`NoteTemplate`/`NoteGeneration`/
// `NoteVersion`/`NoteExport` scalar field name sets, and their enums
// (issue #48, epic #45)
// =============================================================================
//
// Nothing in `src/notes/` exists yet — the service, the controllers, the
// generation pipeline all arrive in later issues (#49-#53). What can be
// locked down here, before any of that exists, is the schema itself: a
// column renamed or dropped on any of the five models should fail loudly,
// here, naming the field and the model — not surface later as a silently
// `undefined` property in a service built on top of this schema. Same
// purpose and same technique as `test/jobs/job-model-fields.spec.ts` and
// `test/nodes/worker-node-model-fields.spec.ts`: asserted against
// `Prisma.<Model>ScalarFieldEnum`, generated straight from
// `prisma/schema.prisma` by `prisma generate`, rather than a hand-copied
// list read off the schema file, so this spec fails the moment the two
// actually disagree.
//
// This is also where a handful of issue #48 column-list decisions this
// codebase could otherwise silently drift from are pinned directly — issue
// #48's own stated column list for each of the five models, not
// docs/specs/notes.md §4's narrower subset:
//   - `notes` carries `body` (the live working copy, `@db.Text`), `provider`
//     and `model` (who/what produced the current body) — see the block
//     comment above the `Note` model in schema.prisma for the
//     `notes.body` / `note_versions.body` invariant this locks down.
//   - `notes` also carries `title_source` (#180, epic #163) — the one column
//     that tells an AI titling pass whether a name was chosen by a person and
//     is therefore sticky, or merely inherited from the template and may be
//     improved on.
//   - `note_generations` carries a `jobId` column, `@unique`/nullable/
//     `SetNull`, mirroring `DatabaseBackupRun.jobId`/`TranscriptExport
//     .jobId` — see the block comment above the `NoteGeneration` model.
//   - `note_versions` carries a `summary` column, matching
//     `TranscriptVersion.summary`.
//   - `note_templates` carries `outputFormat`, `structure` (`Json`),
//     `tone`, `length`, `model` and `isArchived` alongside `instructions` —
//     six real, round-trippable fields #56's template editor presents as
//     controls, not composed into the prose (see the block comment above
//     the `NoteTemplate` model).
// =============================================================================

import {
  Prisma,
  NoteStatus,
  NoteSourceType,
  NoteGenerationKind,
  NoteGenerationStatus,
  NoteGenerationErrorClass,
  NoteVersionKind,
  NoteExportStatus,
  TranscriptExportStatus,
} from '@prisma/client';

function expectScalarFields(enumName: keyof typeof Prisma, expected: string[]) {
  const actual = Object.keys(Prisma[enumName] as Record<string, string>).sort();
  expect(actual).toEqual([...expected].sort());
}

function expectFieldsMapToThemselves(enumName: keyof typeof Prisma) {
  const fieldEnum = Prisma[enumName] as Record<string, string>;
  for (const field of Object.keys(fieldEnum)) {
    expect(fieldEnum[field]).toBe(field);
  }
}

describe('Prisma.NoteScalarFieldEnum', () => {
  it('has exactly the field names issue #48 documents Note to have, plus #180\'s titleSource', () => {
    expectScalarFields('NoteScalarFieldEnum', [
      'id',
      'ownerId',
      'title',
      'titleSource',
      'body',
      'status',
      'currentVersion',
      'provider',
      'model',
      'currentGenerationId',
      'sourceType',
      'sourceTranscriptId',
      'sourceNoteId',
      'sourceObjectId',
      'templateId',
      'contextText',
      'failureReason',
      'deletedAt',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('maps every field name to itself', () => {
    expectFieldsMapToThemselves('NoteScalarFieldEnum');
  });

  it('carries `body`, `provider` and `model` — the live working copy of the note plus who/what produced it (issue #48)', () => {
    const fields = Object.keys(Prisma.NoteScalarFieldEnum);
    expect(fields).toContain('body');
    expect(fields).toContain('provider');
    expect(fields).toContain('model');
  });
});

describe('Prisma.NoteTemplateScalarFieldEnum', () => {
  it('has exactly the field names issue #48 documents NoteTemplate to have', () => {
    expectScalarFields('NoteTemplateScalarFieldEnum', [
      'id',
      'ownerId',
      'name',
      'description',
      'instructions',
      'outputFormat',
      'structure',
      'tone',
      'length',
      'model',
      'isArchived',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('maps every field name to itself', () => {
    expectFieldsMapToThemselves('NoteTemplateScalarFieldEnum');
  });

  it('carries `outputFormat`, `structure`, `tone`, `length`, `model` and `isArchived` — real, round-trippable fields beside `instructions` (issue #48; #56\'s template editor presents these as controls)', () => {
    const fields = Object.keys(Prisma.NoteTemplateScalarFieldEnum);
    for (const required of ['outputFormat', 'structure', 'tone', 'length', 'isArchived', 'model']) {
      expect(fields).toContain(required);
    }
  });
});

describe('Prisma.NoteGenerationScalarFieldEnum', () => {
  it('has exactly the field names issue #48 documents NoteGeneration to have', () => {
    expectScalarFields('NoteGenerationScalarFieldEnum', [
      'id',
      'noteId',
      'kind',
      'status',
      'errorClass',
      'errorDetail',
      'templateId',
      'templateNameSnapshot',
      'contextText',
      'sourceType',
      'sourceTranscriptId',
      'sourceNoteId',
      'sourceObjectId',
      'providerId',
      'model',
      'content',
      'lastEventId',
      'promptTokens',
      'completionTokens',
      // #307: the snapshot of what was sent to the provider.
      'systemPrompt',
      'userContent',
      'sourceVersion',
      'contextCapturedAt',
      'jobId',
      'expiresAt',
      'startedAt',
      'completedAt',
      'createdAt',
    ]);
  });

  it('maps every field name to itself', () => {
    expectFieldsMapToThemselves('NoteGenerationScalarFieldEnum');
  });

  it('carries a `jobId` column, `@unique`/nullable/`SetNull` — mirroring `DatabaseBackupRun.jobId`/`TranscriptExport.jobId` (issue #48, see schema.prisma\'s own block comment)', () => {
    const fields = Object.keys(Prisma.NoteGenerationScalarFieldEnum);
    expect(fields).toContain('jobId');
  });

  it('carries NO updatedAt column — spec §4.4\'s Lifecycle group deliberately omits one', () => {
    const fields = Object.keys(Prisma.NoteGenerationScalarFieldEnum);
    expect(fields).not.toContain('updatedAt');
  });
});

describe('Prisma.NoteVersionScalarFieldEnum', () => {
  it('has exactly the field names issue #48 documents NoteVersion to have', () => {
    expectScalarFields('NoteVersionScalarFieldEnum', [
      'id',
      'noteId',
      'version',
      'kind',
      'body',
      'summary',
      'authorId',
      'generationId',
      'restoredFromVersion',
      'clientBatchId',
      'createdAt',
    ]);
  });

  it('maps every field name to itself', () => {
    expectFieldsMapToThemselves('NoteVersionScalarFieldEnum');
  });

  it('carries a `summary` column, matching `TranscriptVersion.summary` (issue #48)', () => {
    const fields = Object.keys(Prisma.NoteVersionScalarFieldEnum);
    expect(fields).toContain('summary');
  });

  it('carries NO ops column and NO snapshotObjectId column — unlike TranscriptVersion, this is a full-body snapshot, not an op log (spec §4.5)', () => {
    const fields = Object.keys(Prisma.NoteVersionScalarFieldEnum);
    expect(fields).not.toContain('ops');
    expect(fields).not.toContain('snapshotObjectId');
  });
});

describe('Prisma.NoteExportScalarFieldEnum', () => {
  it('mirrors TranscriptExport field for field (spec §4.6, issue #48\'s own instruction)', () => {
    const noteExportFields = Object.keys(Prisma.NoteExportScalarFieldEnum).sort();
    const transcriptExportFields = Object.keys(Prisma.TranscriptExportScalarFieldEnum)
      .map((field) => (field === 'transcriptId' ? 'noteId' : field))
      .sort();

    expect(noteExportFields).toEqual(transcriptExportFields);
  });

  it('maps every field name to itself', () => {
    expectFieldsMapToThemselves('NoteExportScalarFieldEnum');
  });
});

// =============================================================================
// Enums (spec §1.1, §1.2, §4.4, §4.5, mirroring TranscriptExportStatus for
// §4.6)
// =============================================================================

function expectEnumMembers(members: Record<string, string>, expected: string[]) {
  expect(Object.keys(members).sort()).toEqual([...expected].sort());
  for (const key of Object.keys(members)) {
    expect(members[key]).toBe(key);
  }
}

describe('NoteStatus enum (spec §1.1)', () => {
  it('has exactly the five documented states', () => {
    expectEnumMembers(NoteStatus, ['draft', 'generating', 'ready', 'failed', 'deleting']);
  });
});

describe('NoteSourceType enum (spec §4.1)', () => {
  it('has exactly the three documented source kinds — no "none" variant', () => {
    // The issue's proposed solution text lists a fourth `none` member; spec
    // §4.1 is explicit that exactly one of the three source columns is
    // always set, matching sourceType — every note has a source in v1.
    expectEnumMembers(NoteSourceType, ['transcript', 'note', 'document']);
  });
});

describe('NoteGenerationKind enum (spec §4.4)', () => {
  it('has exactly the three documented kinds', () => {
    expectEnumMembers(NoteGenerationKind, ['create', 'regenerate', 'preview']);
  });
});

describe('NoteGenerationStatus enum (spec §1.2)', () => {
  it('has exactly the four documented states', () => {
    expectEnumMembers(NoteGenerationStatus, ['pending', 'streaming', 'succeeded', 'failed']);
  });
});

describe('NoteGenerationErrorClass enum (spec §2.2)', () => {
  it('has exactly the four documented error classes', () => {
    expectEnumMembers(NoteGenerationErrorClass, ['auth', 'refusal', 'rate_limit', 'other']);
  });
});

describe('NoteVersionKind enum (spec §4.5)', () => {
  it('has exactly the three documented kinds', () => {
    expectEnumMembers(NoteVersionKind, ['ai_generated', 'edit', 'restore']);
  });
});

describe('NoteExportStatus enum (spec §4.6, mirrors TranscriptExportStatus)', () => {
  it('has exactly the same three members as TranscriptExportStatus', () => {
    const noteExportStatus = Object.keys(NoteExportStatus).sort();
    const transcriptExportStatus = Object.keys(TranscriptExportStatus).sort();
    expect(noteExportStatus).toEqual(transcriptExportStatus);
  });
});
