import { NotesService } from '../notes.service.js';

// =============================================================================
// A named-argument shape over `NotesService`'s positional constructor
// (issue #224; moved into the slice's testing entry by issue #495, epic #491)
// =============================================================================
//
// `NotesService` takes positional collaborators - see its own constructor for the
// authoritative order - and every spec that builds one directly (rather than through Nest's
// DI, which resolves by type and cannot suffer this) previously called `new NotesService(...)`
// with bare positional arguments and a comment above each one explaining which collaborator it
// stood in for.
//
// That shape has a specific failure mode: inserting a new parameter in the MIDDLE of the
// constructor shifts every argument after it one slot to the right. TypeScript only flags this
// when the total argument COUNT is wrong - issue #224's actual defect was that the count matched
// while two of the arguments had silently swapped which collaborator they were wired to, because
// `as never` on each argument opts the whole call out of structural checking.
//
// Routing construction through one named-argument call site does not make a swap between
// same-typed slots impossible, but it does mean a spec author writes `sources: null as never`
// rather than counting commas, and an inserted/removed/reordered constructor parameter is a type
// error in exactly ONE file (this one) instead of a silent misalignment repeated once per spec.
// Update `NotesServiceTestDeps` here when `NotesService`'s constructor changes; every consumer
// keeps compiling by name.
// =============================================================================

/**
 * The collaborators of `NotesService`, by role.
 *
 * @stability experimental
 */
export interface NotesServiceTestDeps {
  /** The narrowed database client (`KVOX_PRISMA`). */
  prisma: ConstructorParameters<typeof NotesService>[0];
  /** The audit port (`KVOX_AUDIT`). */
  audit: ConstructorParameters<typeof NotesService>[1];
  /** The job port (`KVOX_JOBS`). */
  jobs: ConstructorParameters<typeof NotesService>[2];
  /** `NoteAccessService`. */
  access: ConstructorParameters<typeof NotesService>[3];
  /** `NoteSourceNameService`. */
  sourceNames: ConstructorParameters<typeof NotesService>[4];
  /** `NoteTemplateAccessService`. */
  templates: ConstructorParameters<typeof NotesService>[5];
  /** `NoteGenerationRequestService`. */
  requests: ConstructorParameters<typeof NotesService>[6];
  /** `NoteSourceService`. */
  sources: ConstructorParameters<typeof NotesService>[7];
  /** `SearchIndexService`. */
  searchIndex: ConstructorParameters<typeof NotesService>[8];
  /** #309's origin resolver. Optional: only single-note responses reach it. */
  origins?: ConstructorParameters<typeof NotesService>[9];
}

/**
 * Builds a `NotesService` for a test, naming every collaborator by role.
 *
 * @param deps - the collaborators.
 * @returns the service.
 * @stability experimental
 */
export function createNotesServiceTestFactory(deps: NotesServiceTestDeps): NotesService {
  return new NotesService(
    deps.prisma,
    deps.audit,
    deps.jobs,
    deps.access,
    deps.sourceNames,
    deps.templates,
    deps.requests,
    deps.sources,
    deps.searchIndex,
    deps.origins ?? (null as never),
  );
}
