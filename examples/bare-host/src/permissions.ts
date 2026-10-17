import { NOTES_PERMISSIONS, NOTE_TEMPLATES_PERMISSIONS } from '@marinoscar/kvox-api/notes';
import { TRANSCRIPTS_PERMISSIONS } from '@marinoscar/kvox-api/transcripts';

// The permission sets the slices export as data. A host registers them with whatever
// grants roles; this host has one user who holds all of them (`LocalSingleUserIdentity`).
export { NOTES_PERMISSIONS, NOTE_TEMPLATES_PERMISSIONS, TRANSCRIPTS_PERMISSIONS };
