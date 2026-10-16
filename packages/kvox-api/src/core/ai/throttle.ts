/**
 * The prefix of every per-user AI provider throttle bucket.
 *
 * @stability experimental
 */
export const AI_PROVIDER_THROTTLE_PREFIX = 'ai-provider';

/**
 * The provider-throttle bucket one user's generations draw on.
 *
 * ⚠ ONE BUCKET PER USER — THE EXACT INVERSE OF `TRANSCRIPTION_THROTTLE_KEY`,
 * and the inversion is the whole point (docs/specs/notes.md §2.3). There, every
 * user's transcription authenticates as the SAME deployment-owned AssemblyAI
 * account against ONE vendor rate limit, so one shared key correctly protects
 * it and a 429 discovered by any handler is evidence about all three. Here,
 * every user brings THEIR OWN vendor account with THEIR OWN limit: a 429
 * against user A's key is evidence about user A and about nobody else, so
 * deferring on one shared key would let a single busy user throttle every other
 * user's notes — a relationship between the accounts that does not exist.
 *
 * `ProviderThrottleService` maps `Job.type` → key, so `note.generate` registers
 * this key per job, immediately before the provider call, rather than once at
 * `onModuleInit` the way a shared-bucket handler does. See the handler's own
 * note on what that does and does not buy.
 *
 * @param userId - the user whose own provider account the work spends.
 * @returns the bucket name.
 * @stability experimental
 */
export function aiProviderThrottleKey(userId: string): string {
  return `${AI_PROVIDER_THROTTLE_PREFIX}:${userId}`;
}

/**
 * The one rate-limit bucket of the deployment-owned transcription provider.
 *
 * ⚠ ONE KEY FOR THREE TYPES, ON PURPOSE. Submit, poll and ingest all
 * authenticate as the same account against the same vendor, so they share one
 * rate-limit bucket on the vendor's side. A 429 discovered by `poll` is
 * evidence that `submit` and `ingest` will be throttled too, and registering
 * one key for all three is what lets the provider throttle act on that
 * evidence instead of rediscovering it once per type.
 *
 * @stability experimental
 */
export const TRANSCRIPTION_THROTTLE_KEY = 'transcription-provider';
