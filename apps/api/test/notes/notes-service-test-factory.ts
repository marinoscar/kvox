// =============================================================================
// A named-argument shape over `NotesService`'s positional constructor
// (issue #224)
// =============================================================================
//
// `NotesService` takes eight positional collaborators — see its own
// constructor for the authoritative order — and every `*.db.spec.ts` in this
// directory that builds one directly (rather than through Nest's DI, which
// resolves by type and cannot suffer this) previously called `new
// NotesService(...)` with eight bare positional arguments and a `⚠` comment
// above each one explaining which collaborator it stood in for.
//
// That shape has a specific failure mode: inserting a new parameter in the
// MIDDLE of the constructor (as `sources` was) shifts every argument after it
// one slot to the right. TypeScript only flags this when the total argument
// COUNT is wrong — issue #224's actual defect was that the count matched
// (both specs still compiled at seven-vs-seven relative to the seven-param
// constructor of the PREVIOUS shape) while two of the seven had silently
// swapped which collaborator they were wired to, because `as never` on each
// argument opts the whole call out of structural checking that could have
// caught a type mismatch instead.
//
// Routing construction through one named-argument call site does not make a
// swap between same-typed slots impossible — nothing short of removing
// `as never` entirely could promise that — but it does mean a spec author
// writes `sources: null as never` rather than counting commas, and it means
// an inserted/removed/reordered constructor parameter is a type error in
// exactly ONE file (this one) instead of a silent misalignment repeated once
// per spec. Update `NotesServiceTestDeps` here when `NotesService`'s
// constructor changes; every consumer keeps compiling by name.
import { NotesService } from '../../src/notes/notes.service';

export interface NotesServiceTestDeps {
  prisma: ConstructorParameters<typeof NotesService>[0];
  access: ConstructorParameters<typeof NotesService>[1];
  sourceNames: ConstructorParameters<typeof NotesService>[2];
  templates: ConstructorParameters<typeof NotesService>[3];
  requests: ConstructorParameters<typeof NotesService>[4];
  sources: ConstructorParameters<typeof NotesService>[5];
  jobs: ConstructorParameters<typeof NotesService>[6];
  searchIndex: ConstructorParameters<typeof NotesService>[7];
}

/** Build a `NotesService` for a test, naming every collaborator by role. */
export function buildNotesService(deps: NotesServiceTestDeps): NotesService {
  return new NotesService(
    deps.prisma,
    deps.access,
    deps.sourceNames,
    deps.templates,
    deps.requests,
    deps.sources,
    deps.jobs,
    deps.searchIndex,
  );
}
