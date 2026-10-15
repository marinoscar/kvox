// =============================================================================
// This app's host registrations (issue #464, epic #462)
// =============================================================================
//
// What this app adds to the platform's host slice through its registries:
//
//   * an About group "Transcription" (the active provider and model);
//   * an About group "Deployment" (the deploy-info fields the platform drops).
//
// The two Doctor checks are providers, not registrations: see
// `doctor/doctor-checks.module.ts`.
//
// IMPORTED BY `platform/host-core.config.ts`, so it runs before the application
// is created (the registries freeze when it bootstraps).
//
// An About contributor is registered at module load and its `describe()` takes no
// arguments, so it cannot inject a service. The one service it needs, the
// platform `SettingsResolver`, is handed over by `AboutContributorsBinder` when
// the application starts.
// =============================================================================

import { registerAboutContributor } from '@marinoscar/platform-api/host';
import type { SettingsResolver } from '@marinoscar/platform-api/settings';

import { readDeployExtras } from '../platform/about/deploy-extras';

// PLATFORM-ADOPTION-SHIM(#464): the platform's About contributor has no
// dependency-injection seam (`describe()` takes no arguments), so the resolver
// is held here. Drop this when the contributor contract receives its context.
let settingsResolver: SettingsResolver | null = null;

/** Called once by `AboutContributorsBinder` (`platform/about/about-contributors.module.ts`). */
export function bindAboutSettingsResolver(resolver: SettingsResolver | null): void {
  settingsResolver = resolver;
}

/** The slice of the `transcription` namespace the About group reads. */
interface TranscriptionNamespace {
  provider?: string | null;
  providers?: Record<string, { speechModel?: unknown } | undefined>;
}

/**
 * The "Transcription" group: the provider id and the model it is set to use.
 * NEVER a key, a region or any other setting. `provider` is `none` when no
 * provider is selected.
 */
export async function describeTranscription(
  resolver: Pick<SettingsResolver, 'resolveSystem'> | null = settingsResolver,
): Promise<Record<string, string>> {
  if (!resolver) return {};
  const policy = await resolver.resolveSystem<TranscriptionNamespace | undefined>('transcription');
  const provider = policy?.provider ?? null;
  if (!provider) return { provider: 'none' };

  const model = policy?.providers?.[provider]?.speechModel;
  return typeof model === 'string' && model.length > 0
    ? { provider, model }
    : { provider };
}

registerAboutContributor({
  id: 'transcription',
  label: 'Transcription',
  describe: () => describeTranscription(),
});

registerAboutContributor({
  id: 'deployment',
  label: 'Deployment',
  describe: () => readDeployExtras(),
});
