// =============================================================================
// KVox's own seed rows (issue #465, epic #462)
// =============================================================================
//
// `prisma/seed.ts` runs the platform seed first (`seedPlatform`: roles,
// permissions, default grants, the `global` system settings row, the initial
// administrator's allowlist row, the default organization) and then `seedApp`
// from this file: the rows that belong to KVox alone. Today that is the
// built-in note templates, which used to live in `seed-data.ts` together with
// the role and permission tables the platform seed now owns.
//
// Idempotent: every write is an upsert on a natural unique. Framework-free on
// purpose, like `seed.ts`: no Nest, no `src/` import, so it runs under
// ts-node from a production image that carries `prisma/` but not `src/`.
//
// `NOTE_TEMPLATES` is exported so a Jest test can assert the data (a seed
// script that instantiates a client cannot be imported).

import type { PrismaClient } from '@prisma/client';

// =============================================================================
// Built-in note templates (#48, epic #45)
// =============================================================================
//
// The six VISION.md "Skills" worked examples, seeded with `ownerId: null` —
// docs/specs/notes.md §7.1's built-in convention: readable by every user via
// `GET /api/note-templates`, editable by nobody through the API regardless of
// role (§7.2). Without these, a brand-new account with a valid AI key and
// zero templates of its own could generate nothing (the issue's own stated
// problem this seed exists to solve).
//
// IDEMPOTENT BY A FIXED, HARD-CODED `id`, not a slug column. `note_templates`
// has no `slug` field. A stable, permanent UUID per built-in — upserted by
// `seed.ts` on `where: { id }` — gives the identical idempotency issue #48
// asks for ("running it twice yields one copy of each built-in") without
// adding a column the issue does not call for: `id` already is this table's
// one natural key, a fixed literal is simply what a "well-known" row's
// primary key looks like, and a user's own duplicate-and-edit copy
// (`POST /api/note-templates/:id/duplicate`, spec §7.3) always gets a fresh,
// random `id`, so it can never collide with — or be silently overwritten
// by — a re-run of this seed.
//
// Each `instructions` block is written to stand on its own as the system
// prompt `assemblePrompt` (#49) carries verbatim, and is paired with real
// values for the six structured fields issue #48 lists on `note_templates`
// (`outputFormat`, `structure`, `tone`, `length`, plus an unset optional
// `model` override) — not composed into the prose, but stored beside it, so
// #56's template editor round-trips them as real controls rather than only
// as flattened text. `structure` is the ordered list of sections/headings
// each built-in actually produces, matching what its `instructions` already
// describes.
export const NOTE_TEMPLATES = [
  {
    id: '00000000-0000-4000-a000-000000000001',
    name: 'Concise Meeting Notes',
    description: 'A short, scannable summary of what happened — the essentials only.',
    outputFormat: 'meeting_notes',
    bodyFormat: 'markdown',
    structure: ['Overview', 'Key Points', 'Decisions'],
    tone: 'neutral',
    length: 'short',
    instructions:
      'You write concise meeting notes from a transcript. Produce a short, ' +
      'scannable summary — aim for well under 200 words. Use this structure: ' +
      'a one- or two-sentence Overview of what the meeting was about, a Key ' +
      'Points section listing the main topics discussed as short bullets, and ' +
      'a Decisions section listing anything that was explicitly decided. Skip ' +
      'anything not worth remembering a week from now. Use plain, neutral, ' +
      'professional language. Do not include a play-by-play of who said what ' +
      '— summarize outcomes, not dialogue. Format the whole note as Markdown ' +
      'with headings for each section and bullet points beneath them.',
  },
  {
    id: '00000000-0000-4000-a000-000000000002',
    name: 'Detailed Meeting Notes',
    description: 'A thorough record covering every topic, discussion and outcome in full.',
    outputFormat: 'meeting_notes',
    bodyFormat: 'markdown',
    structure: ['Context', 'Discussion by Topic', 'Decisions Made', 'Open Questions', 'Next Steps'],
    tone: 'professional',
    length: 'long',
    instructions:
      'You write detailed, thorough meeting notes from a transcript. Cover ' +
      'every topic the meeting touched, in the order it was discussed. For ' +
      'each topic, capture the substance of the discussion — not just the ' +
      'conclusion — including differing viewpoints, context that was shared, ' +
      'and any numbers, names or specifics mentioned. Use this structure: a ' +
      'Context section briefly framing what the meeting was for, a Discussion ' +
      'by Topic section with one subheading per topic covering what was said ' +
      'and why it matters, a Decisions Made section listing every decision ' +
      'reached and the reasoning behind it, an Open Questions section for ' +
      'anything left unresolved, and a Next Steps section. Err on the side of ' +
      'completeness — this note should let someone who missed the meeting ' +
      'understand it as well as someone who attended. Write in clear, ' +
      'professional prose. Format the whole note as Markdown with headings ' +
      'and sub-bullets.',
  },
  {
    id: '00000000-0000-4000-a000-000000000003',
    name: 'Executive Summary',
    description: 'A brief, high-level overview for leadership who need the headline, not the transcript.',
    outputFormat: 'summary',
    bodyFormat: 'markdown',
    structure: ['Summary', 'Highlights'],
    tone: 'confident',
    length: 'short',
    instructions:
      'You write a brief executive summary from a transcript, for a reader ' +
      'who was not in the room and does not have time to read a full recap. ' +
      'Open with a single short paragraph (3-5 sentences) stating the purpose ' +
      'of the meeting and its most important outcome or takeaway. Follow it ' +
      'with a "Highlights" section of at most three or four bullet points ' +
      'covering the other facts a leader would need to know — a decision, a ' +
      'risk, a number, a deadline. Deliberately omit discussion detail, ' +
      'process, and anything that does not change what a reader should do or ' +
      'know next. Use confident, business-appropriate language and keep the ' +
      'entire note under about 150 words. Format as Markdown.',
  },
  {
    id: '00000000-0000-4000-a000-000000000004',
    name: 'Action Items',
    description: 'Every task that came out of the conversation, with an owner and due date when stated.',
    outputFormat: 'bullet_list',
    bodyFormat: 'markdown',
    structure: ['Action Items'],
    tone: 'neutral',
    length: 'short',
    instructions:
      'You extract action items from a transcript. Read the whole ' +
      'conversation and list every task, commitment or follow-up someone ' +
      'agreed to do. For each one, produce a single Markdown checklist line ' +
      'in the form: "- [ ] <task> — Owner: <name or role, or "unassigned" if ' +
      'nobody was named> — Due: <date, or "not specified" if none was ' +
      'given>." Do not invent an owner or a due date that was not actually ' +
      'stated — write "unassigned"/"not specified" rather than guessing. List ' +
      'items in the order they came up in the conversation. If the ' +
      'transcript contains no clear action items, say so plainly instead of ' +
      'inventing any. Do not include general discussion points that were not ' +
      'actually commitments to do something.',
  },
  {
    id: '00000000-0000-4000-a000-000000000005',
    name: 'Decision Log',
    description: 'Every decision that was made, why, and who made it — a durable record for later reference.',
    outputFormat: 'bullet_list',
    bodyFormat: 'markdown',
    structure: ['Decisions', 'Deferred'],
    tone: 'neutral',
    length: 'medium',
    instructions:
      'You extract a decision log from a transcript. Read the whole ' +
      'conversation and list every decision that was actually made — not ' +
      'every option that was discussed. For each decision, write a short ' +
      'Markdown entry with: the decision itself, stated as a clear one-line ' +
      'statement; a brief "Why" note capturing the reasoning or context that ' +
      'led to it; and "Decided by:" naming whoever made or approved the call, ' +
      'or "unclear" if the transcript does not say. List decisions in the ' +
      'order they were made. If something was actively discussed but left ' +
      'unresolved, list it under a separate "Deferred" section rather than ' +
      'presenting it as a decision. If no decisions were made at all, say so ' +
      'plainly.',
  },
  {
    id: '00000000-0000-4000-a000-000000000006',
    name: 'Follow-up Email',
    description: 'A ready-to-send email recapping the meeting and inviting corrections.',
    outputFormat: 'email',
    bodyFormat: 'markdown',
    structure: ['Subject', 'Greeting', 'Recap', 'Next Steps', 'Closing'],
    tone: 'warm',
    length: 'short',
    instructions:
      'You draft a follow-up email to send to the people who were on this ' +
      'call, based on a transcript of it. Write it as a complete, ' +
      'ready-to-send email: start with a suggested "Subject:" line, then a ' +
      'brief greeting ("Hi all," is fine since attendee names may not be ' +
      'known), a short paragraph recapping what the meeting covered, a ' +
      'bulleted list of next steps or action items (with owners where the ' +
      'transcript names one), and a brief closing line inviting anyone to ' +
      'reply with corrections or additions. Keep the tone warm but ' +
      'professional, and keep the whole email short enough to read in under ' +
      'a minute — this should need little to no editing before it is sent. ' +
      'Do not include a formal sign-off name or signature block, since the ' +
      'sender will add their own.',
  },
] as const;


/**
 * Upsert KVox's own seed rows. Idempotent: a second run changes nothing.
 *
 * @param prisma - The seed script's client.
 */
export async function seedApp(prisma: PrismaClient): Promise<void> {
  await seedNoteTemplates(prisma);
}

async function seedNoteTemplates(prisma: PrismaClient): Promise<void> {
  console.log('Seeding built-in note templates...');

  // Idempotent by the template's own fixed `id` (see the block comment above
  // `NOTE_TEMPLATES` for why there is no separate slug column to key on
  // instead). `update` re-asserts every seeded field so an edit to this file's
  // seed text (prose or structured field alike) lands on a re-run; `ownerId`
  // is never part of `update` because it is never allowed to change: a
  // built-in stays built-in. This never touches a user's own
  // duplicate-and-edit copy (`note_templates.duplicate`, docs/specs/notes.md
  // §7.3), which always gets a fresh, random `id` distinct from every one of
  // these fixed ones.
  for (const template of NOTE_TEMPLATES) {
    await prisma.noteTemplate.upsert({
      where: { id: template.id },
      update: {
        name: template.name,
        description: template.description,
        instructions: template.instructions,
        outputFormat: template.outputFormat,
        bodyFormat: template.bodyFormat,
        structure: [...template.structure],
        tone: template.tone,
        length: template.length,
      },
      create: {
        id: template.id,
        ownerId: null,
        name: template.name,
        description: template.description,
        instructions: template.instructions,
        outputFormat: template.outputFormat,
        bodyFormat: template.bodyFormat,
        structure: [...template.structure],
        tone: template.tone,
        length: template.length,
      },
    });
  }

  console.log(`✓ Seeded ${NOTE_TEMPLATES.length} built-in note templates`);
}
