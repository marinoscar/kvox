// =============================================================================
// TranscriptionRuntimeService (issue #25, epic #19)
// =============================================================================
//
// ONE PLACE THAT TURNS "this deployment's settings" INTO "a provider I can
// call". Three handlers and two endpoints need the same four facts — is
// transcription on, which provider, what are its settings, what is its key —
// and each of them resolving that independently is four chances to check three
// of the four.
//
// It is the runtime counterpart to `TranscriptionConfigService`, which answers
// the same question for a BROWSER and deliberately never decrypts anything.
// This one does decrypt, because a job about to call the vendor genuinely
// needs the key; the two are kept apart so that the path a signed-in user can
// reach and the path that reads a secret are different files with different
// callers, rather than one method with a boolean.
//
// -----------------------------------------------------------------------------
// AN UNCONFIGURED DEPLOYMENT IS A `ProviderAuthError`, NOT AN `Error`
// -----------------------------------------------------------------------------
//
// "Transcription is disabled", "no provider is chosen" and "no API key is
// stored" are all states no retry can change: the next attempt reads the same
// settings row and reaches the same conclusion, three times, before the queue
// gives up and the transcript is failed anyway — three attempts later than it
// could have been, with two extra rows in the job history saying nothing new.
// `ProviderAuthError` is the taxonomy's existing name for "the credential
// cannot be used", and the handlers' domain-failure branch (spec §1.6) turns
// it into `status: failed` plus a `failure_reason` on the FIRST attempt.
//
// ⚠ THE CONTEXT CARRIES A SECRET. `createProviderContext` gives it a
// non-enumerable `toJSON` that redacts, and this service hands it straight to
// the caller without storing it anywhere. Do not log the return value, do not
// put it on an instance field, and do not widen this service to "resolve and
// also do something with it" — the narrower its surface, the fewer places the
// key can reach.
// =============================================================================

import { Injectable } from '@nestjs/common';

import { CredentialsService } from '../credentials/credentials.service';
import { ProviderAuthError } from '../transcription/errors';
import {
  createProviderContext,
  type TranscriptionProvider,
  type TranscriptionProviderContext,
} from '../transcription/providers/transcription-provider.interface';
import { TranscriptionProviderRegistry } from '../transcription/transcription-provider.registry';
import type { SystemTranscriptionValue } from '../transcription/transcription-settings.schema';
import { TranscriptionSettingsService } from '../transcription/transcription-settings.service';
import {
  TRANSCRIPTION_CREDENTIAL_PURPOSE,
  transcriptionCredentialName,
} from '../transcription/transcription-credential.constants';

/** Everything a job needs to call the vendor exactly once. */
export interface ResolvedTranscriptionProvider {
  provider: TranscriptionProvider<never>;
  /** ⚠ Holds the plaintext API key. See the file header. */
  ctx: TranscriptionProviderContext<never>;
  /** The whole `transcription` namespace, already validated. */
  policy: SystemTranscriptionValue;
}

@Injectable()
export class TranscriptionRuntimeService {
  constructor(
    private readonly settings: TranscriptionSettingsService,
    private readonly registry: TranscriptionProviderRegistry,
    private readonly credentials: CredentialsService,
  ) {}

  /** The stored policy, on its own — no credential is read on this path. */
  async policy(): Promise<SystemTranscriptionValue> {
    return this.settings.get();
  }

  /**
   * The active provider without its credential.
   *
   * For callers that need the CAPABILITIES (accepted types, size ceiling) and
   * not the key: `POST /api/transcripts`'s validation, and
   * `selectTranscriptionInput`'s two call sites. Returns `null` rather than
   * throwing, because "nothing is configured" is a 409 on the create path and
   * a normal `wait` on the pipeline path — neither is an exception.
   */
  async activeProvider(): Promise<{
    provider: TranscriptionProvider<never>;
    policy: SystemTranscriptionValue;
  } | null> {
    const policy = await this.settings.get();

    if (!policy.enabled || !policy.provider) return null;

    const provider = this.registry.get(policy.provider);

    if (!provider) return null;

    return { provider, policy };
  }

  /**
   * Is this deployment able to transcribe right now?
   *
   * The same four-fact conjunction `TranscriptionConfigService` documents:
   * enabled, a provider chosen, that provider present in this build, and a key
   * stored for it. Checked with `describe`, never `getSecret` — this answers a
   * capability question and must not decrypt anything to do it.
   */
  async isAvailable(): Promise<boolean> {
    const active = await this.activeProvider();

    if (!active) return false;

    const key = await this.credentials.describe(
      TRANSCRIPTION_CREDENTIAL_PURPOSE,
      transcriptionCredentialName(active.provider.id),
    );

    return key !== null;
  }

  /**
   * The provider, its validated settings and its key, ready to call.
   *
   * Throws `ProviderAuthError` — a DOMAIN failure, not a retryable one — for
   * every way this deployment can be unable to transcribe. See the header.
   */
  async resolve(): Promise<ResolvedTranscriptionProvider> {
    const policy = await this.settings.get();

    if (!policy.enabled) {
      throw new ProviderAuthError(
        'Transcription is turned off for this deployment. An administrator can enable it ' +
          'under Settings → Transcription.',
      );
    }

    if (!policy.provider) {
      throw new ProviderAuthError(
        'No transcription provider has been chosen for this deployment. An administrator ' +
          'can choose one under Settings → Transcription.',
      );
    }

    const provider = this.registry.get(policy.provider);

    if (!provider) {
      // A settings row naming a provider THIS BUILD does not have — what a
      // rollback across the addition of a provider looks like. Naming both the
      // configured id and what is registered is the difference between a
      // one-minute diagnosis and an afternoon.
      throw new ProviderAuthError(
        `This deployment is configured to use the "${policy.provider}" transcription ` +
          'provider, which this build does not include. Registered providers: ' +
          `${this.registry.describeAll().map((entry) => entry.id).join(', ') || 'none'}.`,
      );
    }

    const apiKey = await this.credentials.getSecret(
      TRANSCRIPTION_CREDENTIAL_PURPOSE,
      transcriptionCredentialName(provider.id),
    );

    if (!apiKey) {
      throw new ProviderAuthError(
        `No API key is stored for the ${provider.label} transcription provider. An ` +
          'administrator can add one under Settings → Transcription.',
      );
    }

    // The provider's own settings block, validated by ITS OWN schema rather
    // than trusted from the namespace. The stored row is validated on write,
    // but a row written by an older build with a different schema is exactly
    // the case a parse here catches before the vendor call rather than after.
    const raw = (policy.providers as Record<string, unknown> | undefined)?.[provider.id];
    const parsed = provider.settingsSchema.safeParse(raw);

    if (!parsed.success) {
      throw new ProviderAuthError(
        `The stored settings for the ${provider.label} transcription provider are not ` +
          `valid: ${parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}.`,
      );
    }

    return {
      provider,
      ctx: createProviderContext(apiKey, parsed.data) as TranscriptionProviderContext<never>,
      policy,
    };
  }
}
