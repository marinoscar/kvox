import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { NoteTemplate } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// NoteTemplateAccessService (issue #50, epic #45, docs/specs/notes.md §7.2)
// =============================================================================
//
// ONE FUNCTION, TWO LEVELS, AND TWO DIFFERENT REFUSALS — which is the whole
// reason this is a service of its own rather than three `findFirst` calls
// scattered across a controller:
//
//   require(userId, templateId, 'read' | 'write')
//
// A template resolves for a caller when it is THEIRS or when it is a BUILT-IN
// (`owner_id IS NULL`, spec §7.1). Everything else does not exist as far as
// that caller is concerned.
//
// -----------------------------------------------------------------------------
// ⚠ THE ONE PLACE IN THIS EPIC THAT ANSWERS 403 — AND WHY THAT IS NOT AN
//   INCONSISTENCY WITH THE 404 EVERYTHING ELSE ANSWERS
// -----------------------------------------------------------------------------
//
// It looks like a contradiction, so it is worth stating precisely. Two
// refusals, two different questions:
//
//   • ANOTHER USER'S TEMPLATE → 404. The 404 posture (`TranscriptAccessService`,
//     spec §6.1) exists because the EXISTENCE of a private row is itself
//     information. A 403 would confirm "yes, template abc123 exists" to somebody
//     with no relationship to it at all, and a template a stranger wrote is
//     derived from their private work the same way a note is.
//
//   • A BUILT-IN → 403. A built-in's existence is NOT private. It is listed in
//     every account's own catalogue, by design — the caller is looking at it in
//     their own template picker as they press Edit. Answering 404 would be
//     telling a user that a row they can see, and are looking at, does not
//     exist: misleading rather than protective, and it would send them hunting
//     for a bug that is not there. Confirming "this exists, and nobody may edit
//     it — duplicate it instead" leaks nothing that was not already public and
//     is the one answer they can act on.
//
// The rule the two share: NEVER REVEAL THE EXISTENCE OF A ROW THE CALLER COULD
// NOT ALREADY SEE. A built-in is a row every caller can already see, so nothing
// about it is left to conceal. 404 is not a blanket instruction to lie; it is
// protection for existence that was private in the first place.
//
// Both behaviours are asserted in `test/notes/note-templates.integration.spec.ts`
// side by side, deliberately, because a reader who has not been told the above
// will read them as a bug.
//
// -----------------------------------------------------------------------------
// THE SERVICE RETURNS THE ROW
// -----------------------------------------------------------------------------
//
// Same discipline as `TranscriptAccessService`, and for the same reason: the
// one shape that quietly undoes all of this is a caller that looks the row up
// itself, finds it, and only then asks for permission. There is no reason for
// anything above this to query `note_templates` directly, and no code path
// where a caller holds a template it was not authorised for.
// =============================================================================

/** What a caller is asking to do with a template. */
export type NoteTemplateAccessLevel = 'read' | 'write';

/** The answer: the row, and whether it is one nobody owns. */
export interface NoteTemplateAccess {
  template: NoteTemplate;
  /** `owner_id IS NULL`. Derived, never stored — there is no `is_built_in`. */
  builtIn: boolean;
}

/**
 * The message every no-access answer uses, verbatim.
 *
 * ONE STRING, SHARED, so "there is no such template" and "it is not yours" are
 * byte-identical. Two differently-worded 404s would reintroduce exactly the
 * oracle the status code was chosen to remove.
 */
export const NOTE_TEMPLATE_NOT_FOUND_MESSAGE = 'Note template not found';

/**
 * The message a write against a built-in answers with.
 *
 * It names the remedy, because a refusal a user cannot act on is only half an
 * answer — and duplicate-to-mine (§7.3) is not merely a workaround here, it is
 * the designed path: the user gets their edit, the seeded row stays a stable
 * re-runnable baseline, and there is never any ambiguity about which copy is
 * authoritative.
 */
export const BUILT_IN_TEMPLATE_IMMUTABLE_MESSAGE =
  'Built-in templates cannot be changed or deleted. Duplicate this template to get an editable ' +
  'copy of your own.';

@Injectable()
export class NoteTemplateAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Authorise, and return the row. */
  async require(
    userId: string,
    templateId: string,
    level: NoteTemplateAccessLevel,
  ): Promise<NoteTemplateAccess> {
    const template = await this.prisma.noteTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      throw new NotFoundException(NOTE_TEMPLATE_NOT_FOUND_MESSAGE);
    }

    // =========================================================================
    // ⚠ THE BRANCH THE WHOLE HEADER IS ABOUT.
    // =========================================================================
    //
    // `owner_id IS NULL` means built-in (§7.1). Readable by everyone, writable
    // by nobody — regardless of role, regardless of `note_templates:write`,
    // regardless of being an administrator. The permission gates a user's own
    // custom templates; it has never gated these (§6.3).
    //
    // THIS IS A **403**, NOT THE 404 THE `else` BELOW GIVES SOMEBODY ELSE'S
    // TEMPLATE, and the difference is deliberate: this row is already visible
    // to this caller in their own catalogue, so its existence is not a secret
    // and hiding it would mislead rather than protect. Another user's template
    // IS a secret, and gets the uniform 404. See the header for the full
    // argument; do not "make these consistent".
    if (template.ownerId === null) {
      if (level === 'write') {
        throw new ForbiddenException(BUILT_IN_TEMPLATE_IMMUTABLE_MESSAGE);
      }

      return { template, builtIn: true };
    }

    if (template.ownerId !== userId) {
      throw new NotFoundException(NOTE_TEMPLATE_NOT_FOUND_MESSAGE);
    }

    return { template, builtIn: false };
  }
}
