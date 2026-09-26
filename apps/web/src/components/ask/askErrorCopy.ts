/**
 * Every sentence the Ask surfaces show for a failure, a refusal or a capped
 * answer (#380) — one module so `/ask` and the entity panel (#381) can never
 * word the same outcome two ways.
 */

import { askConflictReason, isAskModelNotPermitted } from '../../services/ask';
import type { AskConflictReason, AskErrorClass, AskFinishReason } from '../../services/ask';
import type { AskStreamErrorClass } from '../../services/askStream';
import { ApiError } from '../../services/api';

/** A failed assistant turn, by `errorClass` (#376's classes plus the stream's `gone`). */
export const ASK_ERROR_CLASS_COPY: Record<AskStreamErrorClass, string> = {
  auth: 'Your AI key was rejected. Check Settings → AI.',
  refusal: 'The model declined to answer.',
  rate_limit: 'Your AI provider is rate-limiting requests. Try again in a minute.',
  budget: 'This question and history are too long for the model. Start a new conversation.',
  timeout: 'Something went wrong answering this.',
  other: 'Something went wrong answering this.',
  gone: 'This conversation is no longer available.',
};

export function askErrorClassCopy(errorClass: AskErrorClass | AskStreamErrorClass | null | undefined): string {
  return ASK_ERROR_CLASS_COPY[errorClass ?? 'other'] ?? ASK_ERROR_CLASS_COPY.other;
}

/** The 409s `POST …/messages` can answer (#378). */
export const ASK_CONFLICT_COPY: Record<AskConflictReason, string> = {
  graph_disabled: 'Ask is turned off for this deployment.',
  ai_not_configured: "An administrator hasn't set up AI yet.",
  ai_key_missing: 'Add your AI key in Settings → AI.',
  model_lacks_capability: "That model can't use tools. Pick another model.",
  ask_turn_running: 'Wait for the current answer to finish.',
};

export const ASK_MODEL_NOT_PERMITTED_COPY = "That model isn't permitted on this deployment. Pick another.";
export const ASK_SEND_FALLBACK_COPY = 'Your question could not be sent. Try again.';

export interface AskSendErrorCopy {
  message: string;
  /** Set for `ai_key_missing` — where the fix is. */
  link: { to: string; label: string } | null;
}

/** The alert above the composer for a failed send. The typed text is kept either way. */
export function askSendErrorCopy(err: unknown): AskSendErrorCopy {
  const reason = askConflictReason(err);
  if (reason) {
    return {
      message: ASK_CONFLICT_COPY[reason],
      link: reason === 'ai_key_missing' ? { to: '/settings/ai', label: 'Open Settings → AI' } : null,
    };
  }
  if (isAskModelNotPermitted(err)) return { message: ASK_MODEL_NOT_PERMITTED_COPY, link: null };
  if (err instanceof ApiError && err.status === 404) {
    return { message: "This conversation doesn't exist any more.", link: null };
  }
  if (err instanceof ApiError && err.message && err.status >= 400 && err.status < 500) {
    return { message: err.message, link: null };
  }
  return { message: ASK_SEND_FALLBACK_COPY, link: null };
}

/** The caption under an answer that ended on a cap (spec §21.3). `null` for `stop`. */
export function askFinishReasonCopy(finishReason: AskFinishReason | null | undefined): string | null {
  switch (finishReason) {
    case 'step_cap':
      return 'Stopped early — this answer may be incomplete: it reached the lookup limit.';
    case 'token_cap':
      return 'Stopped early — this answer may be incomplete: it reached the length limit.';
    case 'time_cap':
      return 'Stopped early — this answer may be incomplete: it ran out of time.';
    default:
      return null;
  }
}

/** "1 source couldn't be verified and was removed" / "3 sources couldn't…". */
export function askUnverifiedCopy(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 source couldn't be verified and was removed."
    : `${count} sources couldn't be verified and were removed.`;
}

export const ASK_UNCITED_COPY = 'No sources were cited — treat this answer with care.';
export const ASK_DISABLED_COPY = 'Ask is turned off for this deployment';
