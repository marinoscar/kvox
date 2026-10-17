// The notes slice's domain event (issue #495, epic #491): `kvox.notes.note_ready` is
// emitted on `KVOX_EVENTS` AFTER the transaction that marks a note `ready` has committed
// (never inside it), so a listener that reads the note sees the committed row. It is how
// the connected-knowledge graph learns there is a note to extract from, without the notes
// slice importing the graph: the graph subscribes (until it moves into the package, the web
// edition's temporary listener next to its graph does).
//
// A LISTENER IS A BYSTANDER: it decides whether work is due and enqueues it. A listener that
// throws is logged by the host's event port and never fails or rolls back the note.
//
// The name and the payload live in `@marinoscar/kvox-contract/notes`, so a package that is
// not this slice can name them too.

export { NOTE_READY_EVENT, type NoteReadyEvent } from '@marinoscar/kvox-contract/notes';
