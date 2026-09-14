import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { PatchSystemSettingsDto } from '../settings/dto/update-system-settings.dto';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { AiProviderRegistry } from './ai-provider.registry';
import type { SystemAiPatchValue, SystemAiValue } from './ai-settings.schema';
import type { AiProviderDescription } from './providers/ai-provider.interface';
import { OPENAI_FETCH, type FetchLike } from './providers/openai.provider';

// =============================================================================
// AiSettingsService (issue #47, epic #45)
// =============================================================================
//
// The DEPLOYMENT-POLICY half of epic #45: is AI on, which endpoint may be
// called, which models are permitted, and what ceilings bound one request.
//
// ⚠ THE ASYMMETRY WITH `TranscriptionSettingsService` IS THE WHOLE POINT OF
// THIS FILE. That service has two destinations — the settings namespace and the
// encrypted credential store — because a transcription key is deployment-scoped.
// THIS SERVICE HAS ONE. There is no deployment AI key to write, read, rotate or
// erase; every key belongs to an individual user and lives behind
// `UserAiCredentialsService` and a cascading foreign key (docs/specs/notes.md
// §9's strict-BYO decision). So:
//
//   • nothing in this file touches `CredentialsService`;
//   • nothing in this file accepts an `apiKey` field, and
//     `ai-settings.schema.ts` carries a compile-time proof that the namespace
//     has no field able to hold one;
//   • `POST /api/ai-settings/test` is a REACHABILITY probe with no credential
//     at all — see `testReachability` below, which is why its contract differs
//     from every other `/test` endpoint in this codebase.
//
// Writes go through `SystemSettingsService.patchSettings`, so the merge, the
// validation, the unknown-key preservation, the version counter and the
// `system_settings:patch` audit entry are all the ones the `global` row already
// has. `DbBackupAdminService.updateConfig` and `TranscriptionSettingsService`
// are the worked precedents; this module NEVER writes `system_settings`
// directly.
// =============================================================================

/**
 * What the admin AI policy page reads: the configuration and the provider
 * catalogue the form renders itself from.
 *
 * ⚠ NO FIELD HERE CAN HOLD A KEY, at either level. `settings` is the namespace,
 * which carries its own compile-time proof; `providers` is
 * `registry.describeAll()`, a projection of capabilities and form descriptors.
 */
export interface AiSettingsAdminView {
  settings: SystemAiValue;
  /** Capabilities and field descriptors — see `registry.describeAll()`. */
  providers: AiProviderDescription[];
  /**
   * Model ids named by the policy that no registered provider knows about.
   *
   * REPORTED RATHER THAN SILENTLY DROPPED. A model in `allowedModels` with no
   * descriptor cannot be budgeted (docs/specs/notes.md §3.3 needs
   * `contextWindowTokens`), so `GET /api/ai/config` omits it — and an
   * administrator who typed a model id with a typo would otherwise see it
   * saved, listed back, and quietly never offered to anyone, with nothing
   * anywhere to explain why.
   */
  unknownModels: string[];
  /** Bumped on every write of the `global` row. The `If-Match` token. */
  version: number;
  updatedAt: Date | null;
  updatedBy: { id: string; email: string } | null;
}

/** The outcome of the reachability probe. See `testReachability`. */
export interface AiReachabilityTest {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

/** How long the reachability probe waits before calling the endpoint down. */
const REACHABILITY_TIMEOUT_MS = 10_000;

@Injectable()
export class AiSettingsService {
  private readonly logger = new Logger(AiSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly registry: AiProviderRegistry,
    /**
     * The same `fetch` seam the provider uses, injected for the same reason.
     *
     * SHARED RATHER THAN A SECOND TOKEN, deliberately: this probe calls the
     * very endpoint `OpenAiProvider` calls, so a test that replaces one and not
     * the other would leave a route in this module making a real outbound
     * request from CI — which is exactly the failure the seam exists to
     * prevent. `@Optional()` keeps `new AiSettingsService(...)` working in a
     * unit test that does not care.
     */
    @Optional()
    @Inject(OPENAI_FETCH)
    private readonly fetchImpl: FetchLike = ((input: string, init?: unknown) =>
      globalThis.fetch(input, init as RequestInit)) as unknown as FetchLike,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** The stored policy, degraded to defaults if the row is damaged. */
  async get(): Promise<SystemAiValue> {
    return this.systemSettings.getAiPolicy();
  }

  /** Everything `GET /api/ai-settings` renders. */
  async describeForAdmin(): Promise<AiSettingsAdminView> {
    const [settings, row] = await Promise.all([
      this.get(),
      this.prisma.systemSettings.findUnique({
        where: { key: 'global' },
        select: {
          version: true,
          updatedAt: true,
          updatedByUser: { select: { id: true, email: true } },
        },
      }),
    ]);

    return {
      settings,
      providers: this.registry.describeAll(),
      unknownModels: this.findUnknownModels(settings),
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedByUser ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Update the AI policy (`PUT /api/ai-settings`).
   *
   * A PARTIAL UPDATE despite the verb, matching
   * `PUT /api/transcription-settings` exactly: every field is optional, and the
   * merge belongs to `SystemSettingsService.patchSettings`, which already owns
   * unknown-key preservation and the version check.
   *
   * ⚠ THIS METHOD NEVER ACCEPTS A KEY. Its input type has no such field, the
   * namespace it writes has a compile-time proof it has none, and there is no
   * deployment key in this epic to accept — see the file header.
   */
  async update(
    patch: SystemAiPatchValue,
    userId: string,
    expectedVersion?: number,
  ): Promise<AiSettingsAdminView> {
    // ⚠ THE PROVIDER THE SUBMITTED MODELS WILL BELONG TO — which is the one
    // this PATCH is SWITCHING TO when it carries a `provider`, and the stored
    // one otherwise (#78). Reading only the stored value would validate the new
    // vendor's model ids against the old vendor's catalogue in the single
    // request where the two differ, which is precisely the request an
    // administrator makes when migrating.
    const stored = await this.get();
    const providerId =
      patch.provider !== undefined ? patch.provider : stored.provider;
    const provider = providerId ? this.registry.get(providerId) : undefined;

    // A model id the policy names but this build cannot budget is a 400 rather
    // than a silent save, because the failure it produces otherwise is
    // invisible: the model is stored, listed back to the administrator who
    // typed it, and never offered to a single user. The check is here rather
    // than in the zod schema deliberately — it depends on the REGISTRY, which a
    // schema has no access to, and a fork registering its own models must not
    // have to edit a validation rule to make them acceptable.
    // Indexed by the resolved provider id rather than written `?.openai?.`:
    // when `AI_PROVIDER_IDS` grows, this line keeps compiling only if
    // `aiProvidersSchema` grew the matching block in the same edit, which is
    // exactly the parallel change that must not be forgotten.
    const submittedModels = providerId
      ? patch.providers?.[providerId]?.allowedModels
      : undefined;

    if (provider && submittedModels) {
      const known = new Set(provider.capabilities.models.map((m) => m.id));
      const unknown = submittedModels.filter((id) => !known.has(id));

      if (unknown.length > 0) {
        throw new BadRequestException(
          `Unknown model id(s) for provider "${provider.id}": ${unknown.join(', ')}. ` +
            `This build can budget requests for: ${[...known].join(', ')}. ` +
            'A model it does not know the context window of cannot be offered to users, because the token budget has no number to check against.',
        );
      }
    }

    await this.systemSettings.patchSettings(
      { ai: patch } as PatchSystemSettingsDto,
      userId,
      expectedVersion,
    );

    await this.audit(userId, 'ai_settings:update', {
      // SAFE TO RECORD IN FULL: `patch` is a subset of `SystemAiValue`, and
      // that type carries a compile-time proof that it has no secret-bearing
      // field. There is no key in this object and none can become so without
      // that proof failing to compile.
      settings: patch as unknown as Prisma.InputJsonValue,
    });

    this.logger.log(`AI policy updated by user ${userId}`);

    // RE-READ rather than projecting the input: `patchSettings` merges and
    // validates, so the stored value is the only honest answer, and the caller
    // needs the new `version` for its next `If-Match`.
    return this.describeForAdmin();
  }

  /**
   * Probe the configured base URL (`POST /api/ai-settings/test`).
   *
   * ⚠ THIS IS A REACHABILITY PROBE, NOT A CREDENTIAL PROBE, and that is the one
   * respect in which this endpoint differs from every other `/test` in this
   * codebase. There is no deployment key to test with — `POST
   * /api/ai-credentials/test` is where a KEY is proved, by its owner. What an
   * administrator can usefully learn here is whether the base URL they just
   * typed resolves, terminates TLS, and answers like an OpenAI-compatible API
   * at all: the three failures that look identical from a user's failed
   * generation an hour later.
   *
   * SO A **401 IS A SUCCESS** HERE. An unauthenticated request to a correctly
   * configured endpoint is *supposed* to be refused; that refusal is proof the
   * endpoint exists and speaks the protocol. Reporting it as a failure would
   * make a correctly configured deployment look broken — the single most
   * misleading answer this endpoint could give.
   *
   * NEVER THROWS FOR A FAILED PROBE, for the same reason every other probe in
   * this codebase does not: a refused probe is a successful diagnosis.
   */
  async testReachability(
    userId: string,
    baseUrlOverride?: string | null,
  ): Promise<AiReachabilityTest> {
    const settings = await this.get();

    // THE ACTIVE PROVIDER'S BASE URL, not `providers.openai`'s (#78) — a probe
    // that always read one vendor's block would silently test the wrong
    // endpoint the moment a deployment switched vendors, and would report the
    // old one healthy.
    //
    // A SUPPLIED `baseUrl` STILL WINS AND STILL WORKS WITH NO ACTIVE PROVIDER,
    // deliberately: this endpoint exists to prove a URL an administrator has
    // typed but not saved, and "type the URL, then choose the provider" is a
    // legitimate order to do that in.
    const storedBaseUrl = settings.provider
      ? settings.providers[settings.provider].baseUrl
      : null;

    const resolved = baseUrlOverride?.trim() || storedBaseUrl;

    if (!resolved) {
      const detail =
        'No provider is active for this deployment and no base URL was supplied, so there is nothing to probe. Choose a provider (or type a base URL) and try again.';

      await this.audit(userId, 'ai_settings:test', {
        baseUrl: null,
        ok: false,
        latencyMs: 0,
        detail,
        usedSuppliedBaseUrl: false,
      });

      return { ok: false, latencyMs: 0, detail };
    }

    const baseUrl = resolved.replace(/\/+$/, '');

    const startedAt = Date.now();
    let result: AiReachabilityTest;

    try {
      const response = await this.fetchImpl(`${baseUrl}/models`, {
        method: 'GET',
        // NO `authorization` HEADER, and its absence is the test: an
        // unauthenticated request is what makes a 401 meaningful as proof the
        // endpoint exists. There is no deployment key to send in any case.
        signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - startedAt;

      if (response.status === 401 || response.status === 403) {
        // See the header: this is the EXPECTED answer and the healthy one.
        result = {
          ok: true,
          latencyMs,
          detail: `The endpoint is reachable and demanded authentication (HTTP ${response.status}), which is what a correctly configured API base URL does for an unauthenticated request. Individual users prove their own keys from their AI key settings page.`,
        };
      } else if (response.ok) {
        result = {
          ok: true,
          latencyMs,
          detail: `The endpoint is reachable and answered HTTP ${response.status} without authentication. That is unusual for OpenAI itself but normal for a gateway that injects credentials of its own.`,
        };
      } else if (response.status === 404) {
        result = {
          ok: false,
          latencyMs,
          detail: `The endpoint returned HTTP 404 for the documented \`/models\` route. The base URL is probably missing or duplicating a version segment — OpenAI's own is \`https://api.openai.com/v1\`.`,
        };
      } else {
        result = {
          ok: false,
          latencyMs,
          detail: `The endpoint answered HTTP ${response.status}, which is neither a successful read nor the authentication challenge a correctly configured API base URL gives an unauthenticated request.`,
        };
      }
    } catch (err) {
      result = {
        ok: false,
        latencyMs: Date.now() - startedAt,
        detail:
          `Could not reach ${baseUrl} — ${err instanceof Error ? err.message : 'network error'}. ` +
          'The request never got an HTTP response, so this is a DNS, TLS, firewall or typo problem rather than anything to do with a key.',
      };
    }

    // AUDITED, because it is a side-effecting administrative action against a
    // third party. The OUTCOME and the URL are recorded; there is no credential
    // involved to leave out.
    await this.audit(userId, 'ai_settings:test', {
      baseUrl,
      ok: result.ok,
      latencyMs: result.latencyMs,
      detail: result.detail,
      usedSuppliedBaseUrl: Boolean(baseUrlOverride?.trim()),
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Policy-named models no registered provider declares. See `unknownModels`.
   *
   * READ THROUGH THE ACTIVE PROVIDER (#78). A deployment that has chosen no
   * provider, or one this build does not implement, has NOTHING that can budget
   * its permitted models — so every one of them is unknown, which is the honest
   * answer and the one that puts the explanation on the admin page rather than
   * leaving a silently empty model picker.
   */
  private findUnknownModels(settings: SystemAiValue): string[] {
    const providerId = settings.provider;

    // No provider is active: there is no catalogue for a model to be unknown
    // against, and reporting every permitted model as unknown would be noise on
    // a page whose actual problem — nobody has chosen a vendor — the `provider`
    // field states directly.
    if (!providerId) return [];

    const provider = this.registry.get(providerId);

    // A provider named by the settings that this build does not implement (a
    // rollback across its addition). Nothing can budget any of these models, so
    // all of them are unknown.
    if (!provider) return [...settings.providers[providerId].allowedModels];

    const known = new Set(provider.capabilities.models.map((model) => model.id));
    return settings.providers[providerId].allowedModels.filter(
      (id) => !known.has(id),
    );
  }

  /**
   * One audit row.
   *
   * `targetType: 'system_settings'` because that is what this configuration is;
   * `targetId` is the namespace name rather than a row id, so a reader can tell
   * which settings surface an event came from without joining anything — the
   * same convention `TranscriptionSettingsService.audit` uses.
   */
  private async audit(
    actorUserId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType: 'system_settings',
        targetId: 'ai',
        meta: meta as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
