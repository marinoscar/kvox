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
import {
  missingModelNumbers,
  modelKnowledgeOf,
  resolveAllowedModel,
} from './ai-model-resolution';
import { AiProviderRegistry } from './ai-provider.registry';
import type {
  AiTaskKey,
  SystemAiPatchValue,
  SystemAiValue,
} from './ai-settings.schema';
import {
  AI_MODEL_LACKS_CAPABILITY,
  AI_MODEL_NOT_PERMITTED,
  AI_TASK_DEFINITIONS,
  chooseTaskModel,
  missingCapabilities,
  taskDefinition,
  type AiModelCapability,
  type AiTaskDefinition,
} from './ai-task-models';
import type { AiModelLimitSource } from './ai-model-resolution';
import type { AiConfigModel } from './dto/ai-config.dto';
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
   * Model ids named by the policy that this deployment cannot budget for.
   *
   * ⚠ SINCE #78 THIS MEANS "UNRESOLVABLE", NOT "NOT IN THE BUILD CATALOGUE".
   * An entry that carries its own `contextWindowTokens` and `maxOutputTokens`
   * is perfectly usable and is NOT listed here, even though no release of this
   * application has heard of the model — that is the whole point of the widened
   * entry type.
   *
   * ⚠ AND SINCE #97 IT IS NORMALLY EMPTY. The resolver falls through to the
   * active provider's family derivation and then to its conservative floor, so
   * an ordinary typo (`gpt-4p`) now resolves to the floor and is listed as
   * offered rather than as unknown. What is still reported here is an entry
   * NOTHING can answer: a policy naming a provider this build does not
   * implement, or one that declares no floor. The field is kept rather than
   * removed because that case is real and silent — such a model is saved,
   * listed back, and never offered to a single user.
   *
   * REPORTED RATHER THAN SILENTLY DROPPED. Such a model cannot be budgeted
   * (docs/specs/notes.md §3.3 needs `contextWindowTokens`), so
   * `GET /api/ai/config` omits it — and an administrator would otherwise see it
   * saved, listed back, and quietly never offered to anyone, with nothing
   * anywhere to explain why.
   */
  unknownModels: string[];
  /**
   * Every connected-knowledge task (#360) — `AI_TASK_DEFINITIONS` verbatim, so
   * the admin form never hardcodes a label or a capability requirement.
   */
  tasks: AiTaskDefinition[];
  /**
   * The capability flags of each stored `allowedModels` entry this build can
   * resolve (#360), so the form can filter a task's picker by `requires`.
   * Unresolvable entries are in `unknownModels` instead.
   */
  modelCapabilities: AiModelCapabilities[];
  /**
   * What each task would run on right now (#360), computed with the same
   * `chooseTaskModel` the run-time resolver uses but WITHOUT the
   * `graphEnabled` gate, so an administrator can configure tasks before
   * switching the feature on.
   */
  taskModelStatus: AiTaskModelStatus[];
  /** Bumped on every write of the `global` row. The `If-Match` token. */
  version: number;
  updatedAt: Date | null;
  updatedBy: { id: string; email: string } | null;
}

/** One permitted model's capability flags, as the admin view reports them. */
export interface AiModelCapabilities {
  id: string;
  structuredOutput: boolean;
  toolCalling: boolean;
  source: AiModelLimitSource;
}

/** What one task would run on, as the admin view reports it. */
export interface AiTaskModelStatus {
  task: AiTaskKey;
  /** The administrator's `taskModels[task].model`, or null when unset. */
  configuredModel: string | null;
  /** The model the task would actually run on, or null when none can be. */
  effectiveModel: string | null;
  source: 'task' | 'default' | 'none';
  missing: AiModelCapability[];
  /**
   * `not_permitted` is part of the published union for the web contract, but
   * the admin view never reports it: a configured task model that is no longer
   * permitted falls back to the default (`source: 'default'`), which is the
   * designed behaviour rather than a problem.
   */
  problem: null | 'not_permitted' | 'lacks_capability' | 'no_model';
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

    const resolved = this.resolvePermittedModels(settings);

    return {
      settings,
      providers: this.registry.describeAll(),
      unknownModels: this.findUnknownModels(settings),
      tasks: AI_TASK_DEFINITIONS.map((task) => ({
        ...task,
        requires: [...task.requires],
      })),
      modelCapabilities: resolved.map((model) => ({
        id: model.id,
        structuredOutput: model.structuredOutput,
        toolCalling: model.toolCalling,
        source: model.source,
      })),
      taskModelStatus: this.describeTaskModels(settings, resolved),
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
      const knowledge = modelKnowledgeOf(provider);

      // ⚠ NARROWED BY #78 AND AGAIN BY #97: the test is not "is this id in the
      // build catalogue" but "can this entry be BUDGETED AT ALL". An entry
      // carrying its own numbers passes; since #97 so does one whose id the
      // provider can place in a known family, and so does any id at all for a
      // provider that declares a conservative floor. In practice that means
      // this refusal NO LONGER FIRES for a registered provider — which is the
      // point of #97: before it, adopting `gpt-5.4-mini-2026-03-17` meant
      // hand-typing two numbers because the catalogue spells the family without
      // the date.
      //
      // ⚠ THE PATH IS KEPT ANYWAY, AND MUST BE. It is still reachable and still
      // correct for the case it was written for: a policy naming a provider
      // this build does not implement (a rollback across a provider's
      // addition), or one that declines to declare a floor. Deleting it would
      // turn a 400 that names two fields into a model saved, listed back, and
      // silently never offered to anybody — which is exactly the invisible
      // failure it exists to prevent. `resolveAllowedModel` and
      // `missingModelNumbers` share one precedence, so this can never refuse a
      // field the config probe would have filled in.
      const unresolved = submittedModels
        .map((entry) => ({
          entry,
          missing: missingModelNumbers(entry, knowledge),
        }))
        .filter(({ missing }) => missing.length > 0);

      if (unresolved.length > 0) {
        // WORDED AS "SUPPLY THE NUMBERS", NOT "THIS MODEL IS FORBIDDEN". The
        // old message read as a permission refusal and named the ids this build
        // ships with, which told an administrator adopting a new model that
        // their only option was to wait for a release. It is not: the missing
        // thing is a number they can read off the vendor's own documentation,
        // and this sentence has to say so or the widened schema is
        // undiscoverable.
        const detail = unresolved
          .map(({ entry, missing }) => `"${entry.id}" (${missing.join(', ')})`)
          .join(', ');

        throw new BadRequestException(
          `This deployment cannot budget requests for ${detail} on provider "${provider.id}". ` +
            'These models are not forbidden — this build has no context window for them and no way to infer one, so the token budget has no number to check a prompt against. ' +
            'That normally means the provider named by this policy is not implemented by this build. ' +
            'Add `contextWindowTokens` and `maxOutputTokens` to each entry (the vendor publishes both), or choose a model this build already knows: ' +
            `${knowledge.catalogue.map((model) => model.id).join(', ') || 'none'}.`,
        );
      }
    }

    if (patch.taskModels) {
      this.assertTaskModelsValid(patch, stored, providerId);
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
   * Policy entries this deployment cannot budget for. See `unknownModels`.
   *
   * READ THROUGH THE ACTIVE PROVIDER (#78), and resolved with the SAME function
   * `AiConfigService` publishes with — `resolveAllowedModel`. If these two ever
   * used different rules, a model would be listed as unknown on the admin page
   * while being offered to users, or the reverse, and neither disagreement has
   * any visible cause.
   */
  private findUnknownModels(settings: SystemAiValue): string[] {
    const providerId = settings.provider;

    // No provider is active: there is no catalogue for a model to be unknown
    // against, and reporting every permitted model as unknown would be noise on
    // a page whose actual problem — nobody has chosen a vendor — the `provider`
    // field states directly.
    if (!providerId) return [];

    const provider = this.registry.get(providerId);

    // EMPTY KNOWLEDGE rather than an early return for the provider this build
    // does not implement (a rollback across its addition): entries carrying
    // their own numbers still resolve, and refusing to acknowledge that would
    // tell an administrator to fix a model that is already fine.
    // `modelKnowledgeOf(undefined)` is exactly that state, and it is built by
    // the same helper every other call site uses — so the day the bundle grows
    // a fourth member this line does not silently keep passing three.
    return settings.providers[providerId].allowedModels
      .filter((entry) => resolveAllowedModel(entry, modelKnowledgeOf(provider)) === null)
      .map((entry) => entry.id);
  }

  /**
   * Save-time validation of `patch.taskModels` (#360). 400, because it is
   * invalid admin input; the run-time resolver's 409 is the other half.
   *
   * Only the entries PRESENT in the patch are checked, against the allow-list
   * this same patch will leave behind (`patch`'s own `allowedModels` when it
   * carries one, the stored list otherwise). The reverse — narrowing
   * `allowedModels` under a stored task model — is deliberately allowed: the
   * resolver falls back to the default and `taskModelStatus` reports it.
   */
  private assertTaskModelsValid(
    patch: SystemAiPatchValue,
    stored: SystemAiValue,
    providerId: SystemAiValue['provider'],
  ): void {
    const allowed = providerId
      ? (patch.providers?.[providerId]?.allowedModels ??
        stored.providers[providerId].allowedModels)
      : [];
    const knowledge = modelKnowledgeOf(
      providerId ? this.registry.get(providerId) : undefined,
    );

    for (const [task, entry] of Object.entries(patch.taskModels ?? {}) as Array<
      [AiTaskKey, { model: string } | undefined]
    >) {
      if (!entry) continue;
      const definition = taskDefinition(task);
      const permitted = allowed.find((model) => model.id === entry.model);

      if (!permitted) {
        throw new BadRequestException({
          message: `The task model for "${definition.label}" (${entry.model}) is not in the permitted models list.`,
          details: { reason: AI_MODEL_NOT_PERMITTED, task, model: entry.model },
        });
      }

      const resolved = resolveAllowedModel(permitted, knowledge);
      // An entry nothing can resolve has no known capabilities at all, so it
      // lacks every one the task requires.
      const missing = resolved
        ? missingCapabilities(resolved, definition.requires)
        : [...definition.requires];

      if (missing.length > 0) {
        throw new BadRequestException({
          message: `The task model for "${definition.label}" (${entry.model}) does not support ${missing.join(', ')}, which this task requires.`,
          details: {
            reason: AI_MODEL_LACKS_CAPABILITY,
            task,
            model: entry.model,
            missing,
          },
        });
      }
    }
  }

  /**
   * The stored policy's permitted models this build can resolve, with their
   * capability flags, in the policy's order. The same `resolveAllowedModel`
   * `AiConfigService` publishes with.
   */
  private resolvePermittedModels(settings: SystemAiValue): AiConfigModel[] {
    const providerId = settings.provider;
    if (!providerId) return [];

    const knowledge = modelKnowledgeOf(this.registry.get(providerId));

    return settings.providers[providerId].allowedModels
      .map((entry) => resolveAllowedModel(entry, knowledge))
      .filter((model): model is NonNullable<typeof model> => model !== null);
  }

  /** `taskModelStatus`: `chooseTaskModel` for every task, ungated. */
  private describeTaskModels(
    settings: SystemAiValue,
    models: AiConfigModel[],
  ): AiTaskModelStatus[] {
    // The graph switch is lifted here on purpose — see `taskModelStatus`.
    const ungated: SystemAiValue = { ...settings, graphEnabled: true };

    return AI_TASK_DEFINITIONS.map(({ key }) => {
      const choice = chooseTaskModel({ policy: ungated, models, task: key });

      return {
        task: key,
        configuredModel: settings.taskModels[key]?.model ?? null,
        effectiveModel: choice.model,
        // No `requested` model and no gate: only these three ranks occur.
        source: choice.source as AiTaskModelStatus['source'],
        missing: choice.missing,
        problem: choice.problem as AiTaskModelStatus['problem'],
      };
    });
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
