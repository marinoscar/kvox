// =============================================================================
// This app's registrations on the platform user-data slice (issue #480)
// =============================================================================
//
// Pure: no database, no Nest. The scope ids, the confirmation phrases, the
// categories each scope reaches, the delegates' job types and the registration
// order are PERMANENT API (a queued `user.data.purge` job carries a scope id; a
// phrase typed in a client is compared to the registry's), so they are literals
// here, not read back from the manifest. The wider `user-data` conformance suite
// (every owner model decided, hints name what exists, a delete order exists) runs
// in `test/conformance.spec.ts`; the outcomes against a real database are in
// `user-data-purge.db.spec.ts`.
// =============================================================================

import '../../src/kvox.manifest';
import '../../src/app-registrations/registrations';
import '../../src/platform/user-data/user-data.manifest';

import {
  categoriesOfScope,
  resolvedUserDataScopes,
  storageObjectModelHint,
  userDataCategoryRegistry,
  userDataModelRegistry,
} from '@marinoscar/platform-api/user-data';

import { FILES_PURGE_UNMANAGED_JOB_TYPE } from '../../src/kvox-objects/job-types';
import { KG_PURGE_JOB_TYPE } from '@marinoscar/kvox-api/graph';
import { NOTE_PURGE_JOB_TYPE } from '@marinoscar/kvox-api/notes';
import {
  CONTENT_CATEGORIES,
  assertKvoxUserDataRegistrations,
} from '../../src/platform/user-data/user-data.manifest';
import { TRANSCRIPT_PURGE_JOB_TYPE } from '@marinoscar/kvox-api/transcripts';

const USER_ID = '22222222-2222-4222-8222-222222222222';

describe('user-data scopes (permanent API)', () => {
  const scopes = () => Object.fromEntries(resolvedUserDataScopes().map((scope) => [scope.id, scope]));

  it('registers exactly the five scopes, narrowest first', () => {
    expect(resolvedUserDataScopes().map((scope) => scope.id)).toEqual([
      'transcripts',
      'notes',
      'files',
      'content',
      'everything',
    ]);
  });

  it.each([
    ['transcripts', 'TRANSCRIPTS', 'specific'],
    ['notes', 'NOTES', 'specific'],
    ['files', 'FILES', 'specific'],
    ['content', 'CONTENT', 'danger'],
    ['everything', 'EVERYTHING', 'danger'],
  ])('%s asks for the phrase %s on layer %s', (id, phrase, layer) => {
    expect(scopes()[id]).toMatchObject({ confirmation: phrase, layer });
    // The phrase is the scope id uppercased, and none of them is the platform's.
    expect(phrase).toBe(id.toUpperCase());
    expect(phrase).not.toBe('DELETE MY CONTENT');
    expect(phrase).not.toBe('DELETE MY DATA');
  });

  it('reaches, per scope, exactly the categories it always reached', () => {
    const reached = (id: string) => categoriesOfScope(scopes()[id]).sort();

    expect(reached('transcripts')).toEqual(['transcripts']);
    expect(reached('notes')).toEqual(['notes']);
    expect(reached('files')).toEqual(['files']);
    expect(reached('content')).toEqual(['ask', 'files', 'graph', 'noteTemplates', 'notes', 'transcripts']);
    expect(reached('content')).toEqual([...CONTENT_CATEGORIES].sort());
  });

  it('keeps `content` free of the platform categories the built-in content scope would add', () => {
    const content = categoriesOfScope(scopes().content);

    for (const platformCategory of ['notifications', 'ai', 'credentials', 'settings', 'other']) {
      expect(content).not.toContain(platformCategory);
    }
  });

  it('makes `everything` the platform’s `all`: every registered category', () => {
    const everything = categoriesOfScope(scopes().everything);

    expect(scopes().everything.categories).toBe('all');
    expect(everything.sort()).toEqual(userDataCategoryRegistry.ids().sort());
    for (const category of ['ai', 'credentials', 'settings', 'notifications', ...CONTENT_CATEGORIES]) {
      expect(everything).toContain(category);
    }
  });

  it('keeps the narrow `notes` scope off note templates', () => {
    expect(categoriesOfScope(scopes().notes)).not.toContain('noteTemplates');
  });
});

describe('user-data model hints', () => {
  const hint = (model: string) => userDataModelRegistry.get(model);

  it('delegates the module-owned models to their purge jobs, by the handlers’ own type strings', () => {
    expect(hint('Transcript')?.delegate?.jobType).toBe(TRANSCRIPT_PURGE_JOB_TYPE);
    expect(hint('Note')?.delegate?.jobType).toBe(NOTE_PURGE_JOB_TYPE);
    expect(hint('StorageObject')?.delegate?.jobType).toBe(FILES_PURGE_UNMANAGED_JOB_TYPE);
    expect(TRANSCRIPT_PURGE_JOB_TYPE).toBe('transcript.purge');
    expect(NOTE_PURGE_JOB_TYPE).toBe('note.purge');
    expect(KG_PURGE_JOB_TYPE).toBe('kg.purge');
    expect(FILES_PURGE_UNMANAGED_JOB_TYPE).toBe('files.purge_unmanaged');
  });

  it('builds the owner-level payloads the two handlers parse', () => {
    expect(hint('Transcript')?.delegate?.payload(USER_ID)).toEqual({ mode: 'owner', userId: USER_ID });
    expect(hint('Note')?.delegate?.payload(USER_ID)).toEqual({ mode: 'owner', userId: USER_ID });
    expect(hint('StorageObject')?.delegate?.payload(USER_ID)).toEqual({ userId: USER_ID });
  });

  it('shares ONE delegate across every graph model, with the payload kg.purge reads', () => {
    const graphHints = userDataModelRegistry.list().filter((entry) => entry.category === 'graph');

    expect(graphHints.map((entry) => entry.model).sort()).toEqual(
      [
        'KgAttributeDef', 'KgDistinctPair', 'KgEntity', 'KgEntityAlias', 'KgEntityDigest', 'KgEntityView',
        'KgEvidence', 'KgExport', 'KgGraphLayout', 'KgItem', 'KgMention', 'KgMerge', 'KgProposal', 'KgRelation',
      ].sort(),
    );
    for (const entry of graphHints) {
      expect(entry.delegate?.jobType).toBe(KG_PURGE_JOB_TYPE);
      expect(entry.delegate?.payload(USER_ID)).toEqual({ scope: 'all', userId: USER_ID });
    }
  });

  it('deletes Ask conversations and note templates inline, archiving nothing', () => {
    expect(hint('AskConversation')).toMatchObject({ category: 'ask' });
    expect(hint('AskConversation')?.delegate).toBeUndefined();
    expect(hint('NoteTemplate')).toMatchObject({ category: 'noteTemplates', keepWhenReferenced: true });
    expect(hint('UserHiddenNoteTemplate')).toMatchObject({ category: 'noteTemplates' });
  });

  it('keeps derived search state, which the purge jobs remove', () => {
    expect(hint('SearchIndexState')?.keep).toBeTruthy();
  });

  it('registered the StorageObject hint BEFORE the platform’s, so a deletion never collects the whole object list', () => {
    expect(storageObjectModelHint()).toBeUndefined();
    expect(hint('StorageObject')?.storageObjects).toBeUndefined();
    expect(hint('StorageObject')?.category).toBe('files');
    expect(() => assertKvoxUserDataRegistrations()).not.toThrow();
  });

  it('describes `files` in this app’s words, not the platform’s', () => {
    expect(userDataCategoryRegistry.get('files')?.description).toBe(
      'Files you uploaded yourself. Audio and documents that belong to a transcript or note are deleted with them.',
    );
  });

  it('left the platform’s own categories and hints in place', () => {
    for (const id of ['notifications', 'ai', 'credentials', 'settings']) {
      expect(userDataCategoryRegistry.has(id)).toBe(true);
    }
    expect(hint('UserAiKey')).toMatchObject({ category: 'ai' });
    expect(hint('PersonalAccessToken')).toMatchObject({ category: 'credentials' });
    expect(hint('UserSettings')).toMatchObject({ category: 'settings' });
  });
});
