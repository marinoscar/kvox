import type {
  DataTablesValue,
  NavigationValue,
  NotificationsValue,
  OnboardingValue,
} from '../schemas/user-settings-namespaces.schema';
import {
  DEFAULT_MAINTENANCE_MESSAGE,
  type UserProfileSettingsValue,
  type SystemNotificationsValue,
  type SystemJobsValue,
  type SystemNodesValue,
  type SystemDatabaseBackupValue,
  type SystemMaintenanceValue,
  type SystemTranscriptionValue,
  type SystemAiValue,
} from '../schemas/settings.schema';

// =============================================================================
// Settings Type Definitions
// =============================================================================

/**
 * User settings schema - stored in user_settings.value JSONB
 */
export interface UserSettingsValue {
  theme: 'light' | 'dark' | 'system';
  /**
   * Profile preferences (#367). `imageSource` chooses which picture represents
   * the user: none, the OAuth provider's picture, or one they uploaded.
   * `imageObjectId` is the uploaded avatar's `storage_objects` id and is kept
   * when the source is switched away from `upload`, so switching back does not
   * need a second upload. Derived from the zod schema so the two cannot drift.
   *
   * Rows written before #367 carry `useProviderImage`/`customImageUrl` instead;
   * they are normalised on read by `normalizeProfileSettings`
   * (common/profile-image/profile-image.ts), never migrated.
   */
  profile: UserProfileSettingsValue;
  /**
   * Per-table view preferences, keyed by table id.
   *
   * Optional on purpose, and derived from the zod schema so the two can never
   * drift. Absent means "the user has expressed no table preferences yet" —
   * NOT "empty preferences". See user-settings-namespaces.schema.ts.
   */
  dataTables?: DataTablesValue;
  /**
   * Navigation chrome preferences. Absent means "use built-in defaults".
   */
  navigation?: NavigationValue;
  /**
   * Per-channel, per-event notification preferences (#126), channel-outer:
   * `{ email: { 'user.welcome': false } }`.
   *
   * SPARSE AND OPTIONAL AT EVERY LEVEL. Absent namespace, absent channel and
   * absent event key all mean the same thing — "use the event's
   * `defaultEnabled` from the registry" — which is what lets this feature ship
   * with no migration and no backfill, and is why an untouched account is not
   * muted. The dispatcher resolves it; see
   * notifications/notification-preferences.ts.
   */
  notifications?: NotificationsValue;
  /**
   * First-run onboarding INTENT (#272, epic #271): when the welcome was seen,
   * when the user checklist was dismissed, when the administrator setup banner
   * was dismissed, and which optional steps were explicitly skipped.
   *
   * OPTIONAL, AND ABSENT IS LOAD-BEARING — it is the epic's own signal that
   * this user has never been onboarded, which is why `onboarding` appears in
   * this interface but deliberately NOT in `DEFAULT_USER_SETTINGS` below.
   *
   * Nothing about onboarding READINESS lives here. Whether OAuth is configured,
   * whether anyone is allowlisted, whether this account has an AI key — all of
   * that is derived from live state on every read (#274), because a readiness
   * fact frozen into a settings row starts lying the moment a deployment
   * changes. This namespace records only what the user decided.
   *
   * Derived from the zod schema so the two cannot drift.
   */
  onboarding?: OnboardingValue;
}

/**
 * System settings schema - stored in system_settings.value JSONB
 */
export interface SystemSettingsValue {
  /**
   * Deployment-wide browser-notification policy (#225, epic #215).
   *
   * REQUIRED, not optional, and modelled rather than an untyped flag — see
   * `systemNotificationsSchema` in schemas/settings.schema.ts for the full
   * argument. Required is what makes a PUT that omits the block a loud 400
   * instead of a silent reset: the value being reset would be an operator's
   * decision to turn a delivery channel OFF, and silently turning it back on is
   * the one failure mode a security-adjacent gate must not have.
   *
   * Derived from the zod schema so the two cannot drift, exactly as the user
   * settings namespaces above are.
   */
  notifications: SystemNotificationsValue;
  /**
   * Operations namespaces (#256, epic #254): the job queue, the worker fleet,
   * database backup/restore and the maintenance window.
   *
   * REQUIRED, exactly like `notifications` above and for the same reason: this
   * type describes the value this code works with, and every read of the column
   * goes through `readKnownSettings`, which fills each block from
   * `DEFAULT_SYSTEM_SETTINGS` when storage has nothing. A consumer therefore
   * never has to ask whether a block is there, which is the whole point of
   * declaring them before the consumers exist — an optional field would push a
   * `?? DEFAULT` into every future call site, and one of those would be
   * forgotten.
   *
   * A row written before this issue genuinely lacks these keys on disk. That is
   * not a contradiction: `readKnownSettings` is the boundary where "what is on
   * disk" becomes "what this type promises", and the first write after this
   * ships materialises the blocks with their defaults.
   *
   * Derived from the zod schemas so the two cannot drift, as everything else
   * here is.
   */
  jobs: SystemJobsValue;
  nodes: SystemNodesValue;
  databaseBackup: SystemDatabaseBackupValue;
  maintenance: SystemMaintenanceValue;
  /**
   * Transcription policy (#23, epic #19): the active provider, its region and
   * model, how audio reaches it, and what happens to it afterwards.
   *
   * REQUIRED, like every namespace above, and for the same reason. The
   * provider API KEY is deliberately NOT part of this type and cannot become
   * so — `SystemTranscriptionValue` carries a compile-time proof that it has
   * no secret-bearing field.
   */
  transcription: SystemTranscriptionValue;
  /**
   * AI policy (#47, epic #45): whether AI is on, which endpoint is called,
   * which models are permitted, and the token/time ceilings on one request.
   *
   * REQUIRED, like every namespace above, and for the same reason.
   *
   * ⚠ NO API KEY IS PART OF THIS TYPE AND NONE CAN BECOME SO — `SystemAiValue`
   * carries a compile-time proof that it has no secret-bearing field. Unlike
   * `transcription`, there is no key in the `credentials` table either: every
   * AI key belongs to an individual user and lives in `user_ai_credentials`.
   */
  ai: SystemAiValue;
}

/**
 * Default user settings
 */
// NOTE: `dataTables`, `navigation`, `notifications` and `onboarding` are
// intentionally NOT listed here.
// Seeding them would turn "absent" into "explicitly empty", which is exactly
// the failure mode the namespaces are designed to avoid (a frozen column set
// that silently hides every column added later, a notification preference map
// that freezes a user at the defaults of the day they first saved, or — for
// `onboarding`, #272 — an account being told it has already been through a
// first run it has never seen, silently disabling the welcome dialog for every
// user created after the feature shipped).
export const DEFAULT_USER_SETTINGS: UserSettingsValue = {
  theme: 'system',
  profile: {
    imageSource: 'provider',
    imageObjectId: null,
  },
};

/**
 * Default system settings
 */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsValue = {
  // ON by default, suppressing nothing. The opposite default would mean a fresh
  // deployment ships with a delivery channel silently off and no indication
  // anywhere that it was ever available — an operator opts OUT of browser
  // notifications, never into them.
  notifications: {
    browserEnabled: true,
    disabledEvents: [],
  },
  // ---------------------------------------------------------------------------
  // Operations namespaces (#256, epic #254)
  // ---------------------------------------------------------------------------
  //
  // THE ONE PLACE THESE NUMBERS LIVE. None of the schemas carries a
  // `.default()`, deliberately: a default in zod is applied by whichever
  // `parse` runs first, which makes "what does a fresh deployment do?" a
  // question you answer by reading parse call sites. Here it is a question you
  // answer by reading this object.
  //
  // Every value below is also chosen to be INERT. `jobs.history.purgeEnabled`
  // is the only one that is on, and it only bounds a table nothing writes to
  // yet; backups ship disabled, and so does the maintenance window. A default
  // that started doing something on upgrade would be a behaviour change smuggled
  // in by a schema-only issue.
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
    // ⚠ OFF, AND THE DEFAULT IS THE POINT (#349, epic #345). A fresh
    // deployment does not hand its worker fleet credentials to its own
    // database because somebody registered a node; an administrator turns
    // this on deliberately, having decided that those machines are inside the
    // trust boundary. Fail-closed also means a settings row that cannot be
    // read degrades to "no credentials for anyone", which is the safe
    // direction — unlike the fleet's other three values, where degrading to
    // the shipped policy is the safe direction.
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
    // OFF, like `nodes.jobSecretBrokerEnabled` and for a related-but-distinct
    // reason (#352, epic #345): a fresh deployment does not ship its entire
    // database off the API server because somebody registered a worker node.
    // Both switches must be on, and the credential broker must report itself
    // usable, before `db.backup.run` is offered to a node at all.
    nodeOffloadEnabled: false,
  },
  // ---------------------------------------------------------------------------
  // Transcription (#23, epic #19)
  // ---------------------------------------------------------------------------
  //
  // INERT, like every operations default above it: `enabled: false` and
  // `provider: null` mean an upgrade changes nothing until an administrator
  // chooses a vendor and saves a key. The per-provider block is still fully
  // populated, so choosing AssemblyAI is one field rather than four.
  transcription: {
    enabled: false,
    provider: null,
    providers: {
      assemblyai: {
        region: 'us',
        // A comma-separated, ordered `speech_models` list (#95).
        speechModel: 'universal-3-5-pro, universal-2',
      },
    },
    // The provider fetches the audio itself from a signed URL — the bytes
    // never pass through this API. `upload` is for storage the provider
    // cannot reach, which is the exception rather than the default.
    audioDelivery: 'presigned_url',
    // Six hours. It has to outlive the vendor's whole queue-plus-processing
    // time for a long recording; a URL that expires mid-fetch produces a
    // failure that looks like a corrupt file.
    presignedUrlTtlMinutes: 360,
    // ON. Audio sent to a third party is this deployment's responsibility, and
    // leaving it there indefinitely is a retention decision nobody made.
    deleteRemoteAfterIngest: true,
    // `null` means "ask the provider to detect it", which is the right default
    // for a deployment that has not told us what language it works in.
    defaultLanguage: null,
    // ON, unlike `databaseBackup.nodeOffloadEnabled`. Transcoding needs a
    // presigned URL and a CPU, not a credential to this deployment's database
    // — so the trust question the backup's switch answers does not arise.
    transcodeNodeOffloadEnabled: true,
    playback: {
      // 64 kbit/s mono is comfortably intelligible speech at roughly a
      // twentieth the size of the source, which is what a proof-reading
      // rendition is for.
      bitrateKbps: 64,
    },
  },
  maintenance: {
    enabled: false,
    // Shared with the schema so the banner's copy and its validation cannot
    // disagree, and so a fork renaming its product finds no product name here
    // to rename.
    message: DEFAULT_MAINTENANCE_MESSAGE,
    allowAdmins: true,
    startedAt: null,
    startedById: null,
  },
  // ---------------------------------------------------------------------------
  // AI (#47, epic #45)
  // ---------------------------------------------------------------------------
  //
  // INERT, like every namespace above it: `enabled: false` and an EMPTY
  // `allowedModels` mean an upgrade changes nothing at all until an
  // administrator turns AI on and names the models this deployment permits.
  // Both halves of that are load-bearing — an empty allow-list on its own
  // already makes `GET /api/ai/config` report `available: false`, so a
  // deployment that flips `enabled` without choosing models gets a clearly
  // unavailable feature rather than an unbounded one.
  //
  // ⚠ NO API KEY HERE, AND THERE NEVER CAN BE ONE — and unlike
  // `transcription` above, there is none in the encrypted `credentials` table
  // either. Every AI key belongs to an individual user
  // (`user_ai_credentials`, cascading on the user); this namespace carries a
  // compile-time proof that it has no secret-bearing field
  // (`src/ai/ai-settings.schema.ts`).
  ai: {
    enabled: false,
    // `'openai'` RATHER THAN `null`, which is the one place this namespace's
    // defaults deliberately diverge from `transcription` above (#78).
    //
    // The inertness a fresh deployment needs is already carried twice over, by
    // `enabled: false` and by an empty `allowedModels` — so a null provider
    // would buy no additional safety and would cost an administrator a second
    // decision ("which vendor?") to turn on a feature this build has exactly
    // one implementation of. Transcription defaults to `null` because choosing
    // AssemblyAI commits a deployment to sending audio to a specific named
    // company; choosing "the OpenAI-compatible provider" here commits it to
    // nothing until a model is permitted and a user pastes their own key.
    //
    // The field is still nullable, and unsetting it is still meaningful — see
    // `ai-settings.schema.ts`. This is a default, not a claim that `null`
    // cannot happen.
    provider: 'openai',
    providers: {
      openai: {
        // OpenAI's own API root, including the version segment. An
        // OpenAI-compatible gateway is the reason this is a setting at all.
        baseUrl: 'https://api.openai.com/v1',
        // EMPTY on purpose. Naming a model here would be this application
        // choosing which vendor model a deployment's content may be sent to,
        // which is precisely the decision the allow-list exists to leave to an
        // administrator.
        allowedModels: [],
        // A sensible first offer once an administrator permits it (#87: the
        // GPT-5.4 family's mid-size member, rather than `gpt-4o`). Harmless
        // while `allowedModels` is empty: the config probe only ever returns a
        // default that survived the intersection with the allow-list, and
        // since #83 a default naming nothing in an empty list is savable and
        // REPORTED rather than refused — so this names the model a deployment
        // should reach for first without pre-permitting anything.
        defaultModel: 'gpt-5.4-mini',
      },
    },
    // Comfortably inside every model in the OpenAI catalogue, so the model's
    // own context window is the binding constraint on a fresh deployment
    // rather than a ceiling nobody chose.
    maxInputTokens: 100_000,
    // Roughly 12,000 words — long enough for any note this epic generates, and
    // short enough that a runaway completion is bounded on somebody's own bill.
    maxOutputTokens: 16_384,
    // Ten minutes. A streamed completion legitimately runs for minutes; this is
    // the backstop for a wedged connection, not an ordinary HTTP timeout.
    requestTimeoutMs: 600_000,
    // `'none'` — THE VENDOR'S OWN DEFAULT (#87), which is why it is this one.
    // The provider omits the parameter entirely at this value, so an upgrade
    // changes neither the bytes on the wire nor anybody's bill, and a gateway
    // that has never heard of `reasoning_effort` keeps working untouched.
    // Raising it spends the SAME `maxOutputTokens` budget below on thinking
    // instead of on prose — see `ai-settings.schema.ts` for why that is an
    // administrator's decision and not a default.
    reasoningEffort: 'none',
    // 25 MB (#51). Comfortably above any ordinary proposal, contract or brief,
    // and far below anything whose extracted text `maxInputTokens` would let
    // through anyway — a document is bounded here because every byte of it
    // becomes input tokens on the uploading user's own vendor account, and
    // because `note.source.extract` has to hold a whole PDF in memory to read
    // it.
    maxDocumentBytes: 26_214_400,
  },
};
