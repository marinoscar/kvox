// =============================================================================
// `NoteExportDocument` — the one shape every note exporter renders (issue #54)
// =============================================================================
//
// `docs/specs/notes.md` §8.2. The note's counterpart to
// `transcripts/export/export-document.ts`, PURE for the same reason: it is
// built once from the version being exported and handed to whichever renderer
// the caller asked for, so the three renderers **cannot disagree about what the
// note says** — only about how they format it.
//
// It carries none of `ExportDocument`'s speaker/segment/talk-time shape,
// because a note has none of those. What it carries instead is PROVENANCE, and
// that is §8.3's first real difference rather than a smaller document.
//
// -----------------------------------------------------------------------------
// THE PROVENANCE BLOCK IS DEFINED ONCE, HERE, AND IT IS NOT OPTIONAL
// -----------------------------------------------------------------------------
//
// `provenanceEntries(doc)` is the single definition of what the header says and
// in what order, and all three exporters render exactly it. That is deliberate
// on two counts:
//
//   1. VISION.md's Trust-and-Provenance thesis matters most acutely for an
//      artifact that LEAVES THE APPLICATION ENTIRELY. Inside this app a note
//      always carries its source as a live link the reader can click through; a
//      PDF emailed to a client cannot. The provenance block is the export's
//      only carried memory of where the content came from once it is outside —
//      the difference between a document somebody can trace back and an
//      anonymous page of AI text.
//   2. Three renderers each assembling their own header is three chances for
//      one of them to quietly stop naming the template, and a reader holding
//      the DOCX would have no way to know the PDF said more.
//
// ⚠ THERE IS NO `includeProvenance` OPTION, ON PURPOSE. Every other thing an
// exporter can be told to do is a formatting preference; this one is the reason
// the feature exists. An option to switch it off would be an option to produce
// exactly the anonymous page of AI text the block exists to prevent — and,
// because options are part of the content address, it would also mean two
// materially different files sharing one export row's meaning.
// =============================================================================

/** Where a note's content came from, as the export names it. */
export interface NoteExportSource {
  type: 'transcript' | 'note' | 'document';
  /** The source row's id. Never rendered; carried for machine-readable output. */
  id: string;
  /** The transcript title, the source note's title, or the document filename. */
  title: string;
  /**
   * When the source was recorded/created, when that is knowable.
   *
   * Null rather than a fallback to "now": a provenance line that invented a
   * date would be worse than one that omits it, since the whole point of the
   * block is that a reader can trust what it says.
   */
  date: Date | null;
}

/** Who authored the exported version. Null MEANS THE AI, not a missing value. */
export interface NoteExportAuthor {
  displayName: string;
  email: string;
}

/** Which model generated the note, when one did. */
export interface NoteExportProvider {
  id: string;
  model: string | null;
}

/** The provider-neutral document all three note exporters render. */
export interface NoteExportDocument {
  noteId: string;
  title: string;
  /** The exported version's markdown, exactly as stored. */
  body: string;
  version: number;
  /** When the exported VERSION was saved — not when this file was rendered. */
  createdAt: Date;
  /** When this document was rendered. */
  exportedAt: Date;
  author: NoteExportAuthor | null;
  provider: NoteExportProvider | null;
  templateName: string | null;
  source: NoteExportSource;
}

/** Everything the builder needs. Identical to the document minus the derivation. */
export type BuildNoteExportDocumentInput = NoteExportDocument;

/**
 * Build the document. Pure and total.
 *
 * It exists as a function rather than an object literal at the call site for
 * the same reason `buildExportDocument` does: it is the one place a default is
 * applied, so no renderer carries its own opinion about a missing field.
 */
export function buildNoteExportDocument(
  input: BuildNoteExportDocumentInput,
): NoteExportDocument {
  return {
    ...input,
    title: input.title.trim().length > 0 ? input.title : 'Untitled note',
    body: input.body ?? '',
    source: { ...input.source, title: input.source.title.trim() || 'Untitled source' },
  };
}

/** One line of the provenance block: a label and the value beside it. */
export interface ProvenanceEntry {
  label: string;
  value: string;
}

/**
 * The provenance block, in render order. THE definition — see the header.
 *
 * The first four are always present, because issue #54's acceptance criterion
 * is that every format names the source, the template, the version and the
 * timestamp. `Template` reads `None` rather than being dropped when a note was
 * written without one: "this note used no template" is information, and a
 * missing line is indistinguishable from a renderer that forgot.
 *
 * The last two are conditional, because a value that is genuinely absent (a
 * hand-written note has no model; an AI version has no human author) is better
 * omitted than printed as a dash.
 */
export function provenanceEntries(doc: NoteExportDocument): ProvenanceEntry[] {
  const entries: ProvenanceEntry[] = [
    { label: 'Source', value: formatSource(doc.source) },
    { label: 'Template', value: doc.templateName ?? 'None' },
    { label: 'Note version', value: `Version ${doc.version} · saved ${formatDate(doc.createdAt)}` },
    { label: 'Exported', value: doc.exportedAt.toISOString() },
  ];

  if (doc.provider) {
    entries.push({
      label: 'Generated by',
      value: doc.provider.model ? `${doc.provider.id} · ${doc.provider.model}` : doc.provider.id,
    });
  }

  if (doc.author) {
    entries.push({ label: 'Edited by', value: doc.author.displayName });
  }

  return entries;
}

/**
 * `Weekly Sync — Sep 12, 2026 (transcript)`, spec §8.3's own shape.
 *
 * The KIND is named in every case, including for a note source, because
 * "generated from another note" is a materially different provenance claim from
 * "generated from a recording" and a reader outside this application has no
 * other way to tell them apart.
 */
export function formatSource(source: NoteExportSource): string {
  const kind = `(${source.type})`;

  return source.date
    ? `${source.title} — ${formatDate(source.date)} ${kind}`
    : `${source.title} ${kind}`;
}

/** `Sep 12, 2026`, in UTC and without a locale. */
export function formatDate(date: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  // ⚠ UTC GETTERS AND A HAND-WRITTEN MONTH TABLE, never `toLocaleDateString`.
  // The same export rendered on two machines must produce the same bytes —
  // content-addressed reuse (spec §8.4) hands the SECOND caller the FIRST
  // caller's file, so a date that depended on the renderer's timezone or ICU
  // build would make two identical requests legitimately disagree.
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/**
 * `<title> (v<n>).<ext>`, made safe for a filename.
 *
 * The same rules `exportFilename` applies for transcripts, restated for notes
 * rather than imported, because the fallback differs: a note with no usable
 * title falls back to `note`, and an attachment called `transcript (v3).docx`
 * would be actively misleading about what the reader is opening.
 */
export function noteExportFilename(title: string, version: number, extension: string): string {
  const safe = title
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["*/:<>?\\|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // Bounded so the whole name stays inside the 255-byte limit every
    // filesystem and every browser's download path has.
    .slice(0, 120)
    .replace(/[. ]+$/, '');

  return `${safe || 'note'} (v${version}).${extension}`;
}
