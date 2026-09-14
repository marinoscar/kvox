import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AiProviderRegistry } from './ai-provider.registry';
import { AiSettingsService } from './ai-settings.service';
import { AI_PROVIDER_IDS } from './ai-settings.schema';
import {
  createProviderContext,
  type AiDiscoveredModel,
} from './providers/ai-provider.interface';
import { UserAiCredentialsService } from './user-ai-credentials.service';

// =============================================================================
// AiModelDiscoveryService (issue #78, epic #45)
// =============================================================================
//
// `GET /api/ai-settings/models` — ask the configured provider's own API which
// models this deployment could permit, so the admin model policy is chosen from
// a list rather than typed from memory.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A SERVICE OF ITS OWN AND NOT A METHOD ON `AiSettingsService`
// -----------------------------------------------------------------------------
//
// A CIRCULAR DEPENDENCY, and a real one rather than a stylistic worry.
// `UserAiCredentialsService` already injects `AiSettingsService` (it reads the
// policy to build a provider context), so a `discoverModels` method on
// `AiSettingsService` — which must resolve the CALLER'S key — would close the
// loop and force a `forwardRef` on both sides. A `forwardRef` is a permanent
// invitation to a boot-order bug in code neither file can see, and the standing
// alternative in this module is already established: `AiConfigService` is
// likewise a LEAF that composes the policy, the registry and the credential
// service without any of them knowing about it. This is the second one.
//
// -----------------------------------------------------------------------------
// IT SPENDS THE CALLING ADMINISTRATOR'S OWN KEY, BECAUSE THERE IS NO OTHER
// -----------------------------------------------------------------------------
//
// Epic #45 is strict bring-your-own-key: this deployment stores NO AI
// credential of any kind (docs/specs/notes.md §9 rejected a deployment-wide
// fallback outright — shared spend, and a user's private conversation reaching
// the organisation's AI account without them choosing it). So there is nothing
// to fall back to, and discovery has to authenticate as somebody. That somebody
// is the administrator making the request, exactly as `POST
// /api/ai-credentials/test` does, and the consequences are stated rather than
// hidden:
//
//   • an administrator with no key of their own gets a 409, not an empty list —
//     "you have not set up a key" and "the provider offers nothing" are
//     different sentences with different fixes;
//   • the model list is the list THEIR key can reach. On OpenAI that is
//     project-scoped, so two administrators can legitimately see different
//     lists, and the policy they save is checked against neither at generation
//     time — it is checked against each USER'S own key, which is the only
//     authority that matters when the request is finally made.
//
// ⚠ GATED ON `system_settings:write`, NOT `:read`. This is side-effecting: it
// spends a real vendor call. The same argument `POST /api/ai-settings/test`
// makes — looking is not probing — and `:read` is held by everyone who may
// merely look at settings.
//
// ⚠ THE KEY REACHES NOTHING BUT THE PROVIDER CONTEXT. Not a log line, not a
// span attribute, not the audit `meta`, not an error body. The only variables
// permitted in any string this file builds are the provider id and counts.
// =============================================================================

/**
 * What `GET /api/ai-settings/models` answers.
 *
 * ⚠ `ok: false` IS A 200. The `POST /api/transcription-settings/test`
 * convention, and it is the right one here for the same reason: a vendor
 * refusing a key is a SUCCESSFUL DIAGNOSIS, not a failure of this endpoint. A
 * 502 would tell an administrator that this application is broken when what
 * actually happened is that their key has no credit — and it would put the
 * useful sentence in an error body that most clients drop on the floor.
 *
 * The two REAL failures keep their status codes: a provider that cannot be
 * resolved or cannot discover at all is a 400 (the request named something
 * impossible), and a caller with no key is a 409 (the request is fine, the
 * state is not).
 */
export interface AiModelDiscoveryResult {
  /** Whether the provider answered with a list. */
  ok: boolean;
  /** A specific, actionable sentence — the fix, never just the symptom. */
  detail: string;
  /** Empty whenever `ok` is false. Never partial. */
  models: AiDiscoveredModel[];
}

@Injectable()
export class AiModelDiscoveryService {
  private readonly logger = new Logger(AiModelDiscoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AiSettingsService,
    private readonly registry: AiProviderRegistry,
    private readonly credentials: UserAiCredentialsService,
  ) {}

  /**
   * List the models the calling administrator's key can reach.
   *
   * `requestedProvider` defaults to the ACTIVE provider. It exists so an
   * administrator can inspect a vendor's catalogue BEFORE switching to it —
   * the same "prove what you typed, not what you committed" workflow
   * `POST /api/ai-settings/test`'s `baseUrl` override serves.
   */
  async discoverModels(
    userId: string,
    requestedProvider?: string | null,
  ): Promise<AiModelDiscoveryResult> {
    const policy = await this.settings.get();
    const providerId = requestedProvider?.trim() || policy.provider;

    if (!providerId) {
      throw new BadRequestException(
        'No AI provider is active for this deployment and none was named in the request. ' +
          `Choose one first, or pass ?provider= with one of: ${AI_PROVIDER_IDS.join(', ')}.`,
      );
    }

    const provider = this.registry.get(providerId);

    if (!provider) {
      throw new BadRequestException(
        `Unknown AI provider "${providerId}". This build implements: ${this.registry.ids().join(', ') || 'none'}.`,
      );
    }

    if (!provider.capabilities.modelDiscovery || !provider.listModels) {
      // BOTH HALVES CHECKED, even though `AiProviderRegistry.register` refuses
      // a provider where they disagree: the registry's guarantee is about what
      // was REGISTERED, and `listModels` is optional on the interface, so
      // TypeScript needs the second test to let the call below through. The
      // capability check is what produces the honest message; the method check
      // is what makes it type-safe.
      throw new BadRequestException(
        `The provider "${provider.id}" cannot list its models. Model ids for it must be entered by hand — which the settings page always allows, with a context window and output ceiling for any model this build does not already know.`,
      );
    }

    // ⚠ THE CALLER'S OWN KEY. See the header for why there is nothing else to
    // use, and why an absent one is a 409 rather than an empty list.
    const apiKey = await this.credentials.getSecret(userId, provider.id);

    if (!apiKey) {
      throw new ConflictException({
        message:
          `You have not saved an API key for "${provider.id}". This deployment holds no AI key of its own — every key belongs to an individual user — so listing the provider's models has to authenticate as you. ` +
          'Add your key on your AI keys settings page and try again.',
        // ⚠ UNDER `details`, NOT AS A TOP-LEVEL `code`. The global
        // `HttpExceptionFilter` derives `code` from the STATUS and overwrites
        // whatever an exception supplied — a published contract
        // (`common/dto/error.dto.ts`) asserted by that filter's own spec. So a
        // machine-readable reason belongs exactly where the filter says
        // endpoint-specific data belongs, which is what `POST /api/notes`
        // already does with this identical reason string.
        details: { reason: 'ai_key_missing' },
      });
    }

    const storedBlock =
      (policy.providers as Record<string, unknown>)[provider.id] ?? {};

    const settingsParse = provider.settingsSchema.safeParse(storedBlock);

    if (!settingsParse.success) {
      // The DEPLOYMENT's configuration is unusable, not the caller's key —
      // there is no base URL to call. Named as its own 400 so the sentence is
      // about the settings form the administrator is looking at.
      throw new BadRequestException(
        `This deployment's configuration for provider "${provider.id}" is invalid (${settingsParse.error.issues
          .map((issue) => issue.path.join('.') || '(root)')
          .join(', ')}). Correct it and save before loading the model list.`,
      );
    }

    const startedAt = Date.now();
    let result: AiModelDiscoveryResult;

    try {
      const models = await provider.listModels(
        // ⚠ The only place a plaintext key enters a provider context on this
        // path. Built here, passed down, dropped — never stored on an instance
        // field and never logged.
        createProviderContext(apiKey, settingsParse.data),
      );

      result = {
        ok: true,
        detail:
          models.length > 0
            ? `The provider listed ${models.length} chat-capable model(s). Models this build already knows the context window of are marked as such; for any other, supply a context window and output ceiling when you permit it.`
            : 'The provider answered, but listed no chat-capable models this key can reach. That usually means the key is scoped to a project with no chat models enabled.',
        models,
      };
    } catch (err) {
      // ⚠ CAUGHT AND REPORTED AS `ok: false`, NEVER RETHROWN. `listModels`
      // throws by contract (a list has no partial form), and this is the caller
      // the interface names as the one that decides what a refusal means. A
      // revoked key, an account with no credit and a firewall are three
      // different fixes and only one of them is anybody else's problem — so
      // each gets its own sentence, from the provider's own error mapping.
      //
      // `err.message` is safe to surface HERE because every error this path can
      // produce is one `ai-errors.ts` or `openai.provider.ts` wrote, and both
      // forbid key material in a message. A raw vendor body reaches this only
      // through `assertOk`, which bounds it to 500 characters.
      result = {
        ok: false,
        detail:
          err instanceof Error
            ? err.message
            : 'The provider could not be asked for its model list, and gave no reason this application could read.',
        models: [],
      };
    }

    const latencyMs = Date.now() - startedAt;

    // AUDITED exactly as `ai_settings:test` is, and for the same reason: it is
    // a side-effecting administrative action against a third party, made on an
    // individual's credential. The OUTCOME, the provider and the COUNT are
    // recorded; the key is not, the model ids are not (a list of sixty strings
    // in an audit row is noise), and there is nothing else here to leave out.
    await this.audit(userId, {
      provider: provider.id,
      ok: result.ok,
      latencyMs,
      modelCount: result.models.length,
      detail: result.detail,
      usedRequestedProvider: Boolean(requestedProvider?.trim()),
    });

    this.logger.log(
      `Model discovery for provider "${provider.id}" by user ${userId}: ${result.ok ? `${result.models.length} model(s)` : 'refused'}.`,
    );

    return result;
  }

  /**
   * One audit row.
   *
   * `targetType: 'system_settings'` / `targetId: 'ai'`, the same address
   * `AiSettingsService.audit` writes to, so every event from this settings
   * surface reads back together — the convention
   * `TranscriptionSettingsService` established.
   */
  private async audit(
    actorUserId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action: 'ai_settings:discover_models',
        targetType: 'system_settings',
        targetId: 'ai',
        meta: meta as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
