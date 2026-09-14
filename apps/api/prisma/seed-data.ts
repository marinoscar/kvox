// =============================================================================
// Seed Data Definitions
// =============================================================================
//
// The declarative half of `seed.ts`, in a module of its own so it can be
// asserted by a test (#256, epic #254). `seed.ts` instantiates a PrismaClient
// and calls `main()` at import time — it is a script, not a module — so nothing
// in a Jest run can import it to check that the roles it seeds actually name
// permissions it declares, or that the system-settings blob it writes still
// matches the API's `DEFAULT_SYSTEM_SETTINGS`. Splitting the data out costs one
// import and buys `test/prisma/seed-data.spec.ts`.
//
// This file stays framework-free and dependency-free on purpose: it is compiled
// by `prisma/tsconfig.json` under ts-node when `npm run prisma:seed` runs, with
// no Nest build anywhere in sight.
//
// IDEMPOTENCE IS A PROPERTY OF `seed.ts`, NOT OF THIS FILE — every write there
// is an `upsert` keyed on a natural unique (`role.name`, `permission.name`,
// `rolePermission.roleId_permissionId`, `systemSettings.key`), so a second run
// updates the same rows instead of inserting duplicates. What this file
// contributes is that the data itself contains no duplicates to insert, which
// the spec checks.

export const ROLES = [
  {
    name: 'admin',
    description: 'Full system access - manage users, roles, and all settings',
  },
  {
    name: 'contributor',
    description: 'Standard user - can manage own settings and future features',
  },
  {
    name: 'viewer',
    description: 'Read-only access - can view content and manage own settings',
  },
] as const;

export const PERMISSIONS = [
  // System settings
  { name: 'system_settings:read', description: 'Read system settings' },
  { name: 'system_settings:write', description: 'Modify system settings' },

  // User settings
  { name: 'user_settings:read', description: 'Read own user settings' },
  { name: 'user_settings:write', description: 'Modify own user settings' },

  // Users management
  { name: 'users:read', description: 'View user list and details' },
  { name: 'users:write', description: 'Modify user accounts' },

  // RBAC management
  { name: 'rbac:manage', description: 'Manage roles and permissions' },

  // Allowlist management
  { name: 'allowlist:read', description: 'View allowlisted emails' },
  { name: 'allowlist:write', description: 'Manage allowlisted emails' },

  // Storage management
  { name: 'storage:read', description: 'Read object metadata, get download URLs' },
  { name: 'storage:write', description: 'Upload, update metadata' },
  { name: 'storage:delete_any', description: 'Admin: delete any object' },

  // Jobs — the background queue (#256, epic #254)
  { name: 'jobs:read', description: 'View queued, running and completed jobs' },
  { name: 'jobs:write', description: 'Enqueue, retry and cancel jobs' },

  // Worker nodes — the fleet that executes those jobs (#256, epic #254).
  //
  // A SEPARATE PAIR FROM `jobs:*` on purpose. A settings card's `permission`
  // must be the exact string its controller enforces (CLAUDE.md, Settings UI
  // Pattern rule 3), so a Workers card gated on `jobs:read` would mirror a
  // permission the nodes controller never checks — the hub would decide
  // reachability on evidence unrelated to whether the request will be
  // authorized. They are also different questions: what work is queued, versus
  // which machines are attached to this deployment.
  { name: 'nodes:read', description: 'View worker nodes and their health' },
  { name: 'nodes:write', description: 'Register, drain and remove worker nodes' },

  // Database backup (#256, epic #254).
  //
  // `db_backup:restore` is a THIRD permission rather than part of `:write`
  // because the two acts are not comparable. Writing is routine scheduling and
  // is undone by writing again; restoring renames the live database and
  // restarts the process, interrupting every session. Folding restore into
  // write would mean anyone trusted to move a backup window is also trusted to
  // roll production back over the top of itself.
  { name: 'db_backup:read', description: 'View backup schedule, history and status' },
  { name: 'db_backup:write', description: 'Configure the backup schedule and run a backup' },
  { name: 'db_backup:restore', description: 'Restore the database from a backup' },

  // Notification broadcasts — admin messages fanned out to every user
  // (#320, epic #319). A separate pair from `system_settings:*`: broadcasting
  // is not editing the settings document, it's a one-way message to every
  // account in the deployment, so it gets its own controller-enforced
  // permission rather than mirroring one nothing in that controller checks.
  // Plural, matching `jobs:*`/`nodes:*`/`users:*` for a collection resource.
  {
    name: 'broadcasts:read',
    description: 'View notification broadcasts and their delivery history',
  },
  {
    name: 'broadcasts:write',
    description: 'Compose, schedule, cancel and send notification broadcasts',
  },

  // Web Push (VAPID) configuration (#355). A separate pair from
  // `system_settings:*`: generating or rotating the VAPID key pair knocks
  // every existing push subscriber offline until they resubscribe, which is
  // a materially different act from an ordinary settings edit and gets its
  // own controller-enforced permission rather than mirroring one nothing in
  // that controller checks.
  { name: 'push:read', description: 'View Web Push (VAPID) configuration' },
  {
    name: 'push:write',
    description: 'Generate, rotate, enable/disable and remove Web Push VAPID keys',
  },

  // Transcripts (#24, epic #19). Granted to ALL THREE roles below — the
  // opposite of the operational pairs above — because creating a transcript
  // is the core product action and a brand-new account's default role is
  // Viewer. There is deliberately no `transcripts:read_any`: a transcript is
  // a private recorded conversation, not shared infrastructure, and no
  // permission string exists for reading someone else's (an admin included).
  { name: 'transcripts:read', description: 'View your own transcripts and shares' },
  {
    name: 'transcripts:write',
    description: 'Create, edit and delete your own transcripts',
  },

  // Notes (#48, epic #45). Granted to ALL THREE roles below, mirroring
  // `transcripts:*` exactly: generating a note is the core product action,
  // and this app's default role is Viewer. There is deliberately no
  // `notes:read_any` — a note is somebody's private conversation transformed
  // by AI, not shared infrastructure, and no permission string exists for
  // reading someone else's (an admin included). `note_templates:*` is a
  // SEPARATE pair, not folded into `notes:*`: templates and notes are two
  // different controllers with two different write surfaces (a recipe vs.
  // generated content).
  { name: 'notes:read', description: 'View your own notes, versions and generations' },
  {
    name: 'notes:write',
    description:
      'Create, edit, regenerate and delete your own notes; preview a note template',
  },
  {
    name: 'note_templates:read',
    description: 'View built-in and your own note templates',
  },
  {
    name: 'note_templates:write',
    description: 'Create, edit, delete and duplicate your own note templates',
  },
] as const;

// Role to permissions mapping
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [
    'system_settings:read',
    'system_settings:write',
    'user_settings:read',
    'user_settings:write',
    'users:read',
    'users:write',
    'rbac:manage',
    'allowlist:read',
    'allowlist:write',
    'storage:read',
    'storage:write',
    'storage:delete_any',
    // #256, epic #254 — ADMIN ONLY, including the read halves. Contributor and
    // Viewer are deliberately left off: the queue, the fleet and the backup
    // history are operational surfaces, and a read there exposes job payload
    // metadata, host names and the shape of the deployment's schedule. A later
    // issue can widen a specific read to Contributor with an argument for that
    // one surface; starting narrow is the direction that can be relaxed
    // without a migration, since these are rows.
    'jobs:read',
    'jobs:write',
    'nodes:read',
    'nodes:write',
    'db_backup:read',
    'db_backup:write',
    'db_backup:restore',
    // #320, epic #319 — ADMIN ONLY, same reasoning as the jobs/nodes/backup
    // trio just above: broadcasting reaches every user in the deployment, so
    // it starts as narrow as the other operational surfaces here and can be
    // widened later without a migration, since these are rows.
    'broadcasts:read',
    'broadcasts:write',
    // #355 — ADMIN ONLY, same reasoning: rotating VAPID keys knocks every
    // push subscriber offline, so it starts as narrow as the surfaces above
    // and can be widened later without a migration, since these are rows.
    'push:read',
    'push:write',
    // #24, epic #19 — ALL THREE ROLES, the opposite of every operational
    // pair just above. See ROLE_PERMISSIONS.viewer below for the reasoning;
    // it is stated once there rather than three times.
    'transcripts:read',
    'transcripts:write',
    // #48, epic #45 — ALL THREE ROLES, identical posture to transcripts:*
    // just above (see ROLE_PERMISSIONS.viewer below for the reasoning).
    'notes:read',
    'notes:write',
    'note_templates:read',
    'note_templates:write',
  ],
  contributor: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
    'storage:write',
    'transcripts:read',
    'transcripts:write',
    'notes:read',
    'notes:write',
    'note_templates:read',
    'note_templates:write',
  ],
  viewer: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
    // #24, epic #19. Granted to Viewer — this app's DEFAULT_ROLE — and
    // therefore to every role, because recording and reading back a
    // transcript is the core product action, not an operational surface a
    // fresh account should have to be promoted into. Contrast every
    // Admin-only grant above: those gate infrastructure and organisation-
    // wide broadcast authority; this gates a private, per-user resource
    // with no `read_any` counterpart anywhere in this codebase.
    'transcripts:read',
    'transcripts:write',
    // #48, epic #45. Same posture as transcripts:* immediately above:
    // generating a note is the core product action, and a fresh account's
    // default role (this one) must be able to do it from day one. No
    // notes:read_any exists anywhere in this codebase, for any role.
    'notes:read',
    'notes:write',
    'note_templates:read',
    'note_templates:write',
  ],
};

// Default system settings
// Must stay in step with `DEFAULT_SYSTEM_SETTINGS` in
// `src/common/types/settings.types.ts` — the seed cannot import it (this script
// runs outside the Nest build), so the two are a deliberate duplicate. A seeded
// row missing a modelled block is not fatal (`readKnownSettings` degrades it to
// the same defaults), but it does mean the first PATCH is what materialises it.
export const DEFAULT_SYSTEM_SETTINGS = {
  // #225, epic #215. Browser notifications on, nothing suppressed: an operator
  // opts OUT of the channel, never into it.
  notifications: {
    browserEnabled: true,
    disabledEvents: [] as string[],
  },
  // #256, epic #254. Inert defaults: backups and the maintenance window ship
  // off, and the only switch that is on bounds a history table nothing writes
  // to yet. `test/prisma/seed-data.spec.ts` asserts this object still equals
  // the API's `DEFAULT_SYSTEM_SETTINGS` key for key and value for value, which
  // is the only thing standing between the deliberate duplication above and a
  // seeded row that disagrees with the code reading it.
  jobs: {
    history: {
      retentionDays: 30,
      purgeEnabled: true,
    },
    stuckThresholdMinutes: 30,
  },
  nodes: {
    staleHeartbeatSeconds: 90,
    offlineStaleMultiplier: 4,
    offlineRetentionDays: 30,
    // OFF, and the default is the point (#349, epic #345): a fresh deployment
    // does not hand its worker fleet credentials to its own database because
    // somebody registered a node. An administrator opens that trust boundary
    // deliberately.
    jobSecretBrokerEnabled: false,
  },
  databaseBackup: {
    enabled: false,
    frequency: 'daily',
    dayOfWeek: 0,
    dayOfMonth: 1,
    timeOfDay: '02:00',
    timezone: 'UTC',
    retentionCount: 7,
    storageProvider: 's3',
    runStaleMinutes: 120,
    compressionLevel: 6,
    restoreRollbackMode: 'retain_database',
    oldDatabaseRetentionHours: 48,
    // OFF (#352, epic #345). Node offload needs TWO deliberate decisions —
    // this one and `nodes.jobSecretBrokerEnabled` above — because "these
    // machines may hold a short-lived credential" and "the whole database may
    // be dumped somewhere other than the API server" are different questions.
    nodeOffloadEnabled: false,
  },
  // ---------------------------------------------------------------------------
  // Transcription (#23, epic #19)
  // ---------------------------------------------------------------------------
  //
  // INERT on a fresh deployment: `enabled: false` and `provider: null` mean
  // nothing is submitted to any third party until an administrator chooses a
  // vendor and saves a key. The per-provider block is populated anyway, so
  // choosing AssemblyAI is one field rather than four.
  //
  // ⚠ NO API KEY HERE, AND THERE NEVER CAN BE ONE. The provider credential
  // lives in the encrypted `credentials` table at
  // `(purpose 'transcription', name '<providerId>')`; this namespace carries a
  // compile-time proof that it has no secret-bearing field
  // (`src/transcription/transcription-settings.schema.ts`).
  transcription: {
    enabled: false,
    provider: null as string | null,
    providers: {
      assemblyai: {
        region: 'us',
        speechModel: 'universal-3-5-pro, universal-2',
      },
    },
    audioDelivery: 'presigned_url',
    presignedUrlTtlMinutes: 360,
    deleteRemoteAfterIngest: true,
    defaultLanguage: null as string | null,
    transcodeNodeOffloadEnabled: true,
    playback: {
      bitrateKbps: 64,
    },
  },
  // ---------------------------------------------------------------------------
  // AI (#47, epic #45)
  // ---------------------------------------------------------------------------
  //
  // INERT on a fresh deployment: `enabled: false` and an EMPTY `allowedModels`
  // mean nothing is sent to any AI provider until an administrator turns AI on
  // AND names the models this deployment permits. The provider block is
  // populated anyway, so enabling it is two fields rather than five.
  //
  // ⚠ NO API KEY HERE, AND — UNLIKE `transcription` ABOVE — NONE IN THE
  // `credentials` TABLE EITHER. Epic #45 is strict BYO: every AI key belongs to
  // an individual user and lives in `user_ai_credentials` behind a cascading
  // foreign key. This namespace carries a compile-time proof that it has no
  // secret-bearing field (`src/ai/ai-settings.schema.ts`).
  ai: {
    enabled: false,
    // The ACTIVE provider (#78). `'openai'` rather than `null` — unlike
    // `transcription.provider` above — because the inertness of a fresh
    // deployment is already carried by `enabled: false` and the empty
    // `allowedModels`, and this build has exactly one AI provider to choose.
    // See the same comment on `DEFAULT_SYSTEM_SETTINGS`, which this must equal
    // exactly (`test/prisma/seed-data.spec.ts` asserts it).
    provider: 'openai' as const,
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        // Empty, and typed as ids because that is the simplest legal way to
        // write an entry — since #78 an entry may also be an object carrying
        // its own context window, which is what lets a deployment permit a
        // model this build does not know.
        allowedModels: [] as string[],
        // GPT-5.4 mini (#87) — a reasoning model, and a sensible first offer
        // once an administrator permits it. `allowedModels` stays empty, so
        // an administrator still decides what this deployment permits, and
        // since #83 a default naming nothing in an empty list is savable and
        // reported rather than refused.
        defaultModel: 'gpt-5.4-mini',
      },
    },
    maxInputTokens: 100000,
    maxOutputTokens: 16384,
    requestTimeoutMs: 600000,
    // The vendor's own default (#87). Sent as `reasoning_effort` on Chat
    // Completions and omitted entirely at `'none'`, so the wire format is
    // unchanged for anyone who has not opted in. Reasoning tokens are billed
    // and counted as output tokens against the same `maxOutputTokens` ceiling
    // as the answer — which is why the conservative default is the right one
    // to seed.
    reasoningEffort: 'none' as const,
    // 25 MB (#51) — the ceiling on one uploaded note source document.
    maxDocumentBytes: 26214400,
  },
  maintenance: {
    enabled: false,
    // Names no product and no repository — this is a template repo, and the
    // API-side copy of this string (`DEFAULT_MAINTENANCE_MESSAGE`) does not
    // either. A fork that wants its name here reads `APP_NAME` from
    // `@app/shared` at render time rather than baking it into a seeded row.
    message:
      'This service is temporarily unavailable for scheduled maintenance. Please try again shortly.',
    allowAdmins: true,
    startedAt: null as string | null,
    startedById: null as string | null,
  },
};

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
