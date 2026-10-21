// =============================================================================
// The words the Copilot settings card shows — ONE module, so the consent text
// can be reviewed (and its version bumped) in one place
// =============================================================================
//
// Changing `COPILOT_CONSENT_COPY` in a way that changes what the user agrees to
// means bumping `COPILOT_CONSENT_VERSION` in `@marinoscar/kvox-contract/copilot`
// in the same commit: every user who consented to the old text is then asked
// again. Rewording that changes no meaning (a typo) does not need a bump.
//
// The text states only what is true of the integration today:
//   - the text a feature works on (note and transcript text) is sent to GitHub
//     Copilot, which runs the model;
//   - the user signs in with their own GitHub account and Copilot subscription;
//   - it is opt-in, off by default, and can be turned off at any time;
//   - Ask needs tool calling, which Copilot does not offer here.
// It does not state what GitHub does with the text after receipt: that is
// GitHub's terms and the user's Copilot data settings, and the links say so.

import { COPILOT_CONSENT_VERSION, type CopilotStatus } from '@marinoscar/kvox-contract/copilot';

/**
 * The approximate size of the Copilot runtime a host may need to download.
 *
 * @remarks
 * The runtime is a per-platform download of about 133 to 174 MB (the spike
 * notes of `@marinoscar/kvox-ai/copilot`). A host that knows the exact size
 * passes its own text to the card.
 *
 * @stability experimental
 */
export const COPILOT_RUNTIME_SIZE_TEXT = 'about 130 to 175 MB';

/**
 * A link in the consent text.
 *
 * @stability experimental
 */
export interface CopilotCopyLink {
  /** The link text. */
  label: string;
  /** An `https` address. */
  href: string;
}

/**
 * One statement of the consent text.
 *
 * @stability experimental
 */
export interface CopilotConsentPoint {
  /** The short heading. */
  heading: string;
  /** The sentence or two under it. */
  text: string;
}

/**
 * The consent text, as data any design system can render.
 *
 * @stability experimental
 */
export interface CopilotConsentCopy {
  /** The version of this text; equals `COPILOT_CONSENT_VERSION`. */
  version: string;
  /** The dialog title. */
  title: string;
  /** Short statements, in the order shown. */
  points: readonly CopilotConsentPoint[];
  /** The GitHub pages the text refers to. */
  links: readonly CopilotCopyLink[];
  /** The label of the accept button. */
  acceptLabel: string;
  /**
   * The label of the accept button when the host offers the choice of provider itself (the
   * card's `selected` mode), where there is no switch to turn on. It changes only the button,
   * not what the user agrees to.
   */
  acceptSelectedLabel: string;
}

/**
 * GitHub's terms for Copilot and its data and privacy page.
 *
 * @stability experimental
 */
export const COPILOT_TERMS_LINKS: readonly CopilotCopyLink[] = Object.freeze([
  {
    label: 'GitHub terms for additional products and features (GitHub Copilot)',
    href: 'https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot',
  },
  {
    label: 'Responsible use of GitHub Copilot features (data and privacy)',
    href: 'https://docs.github.com/en/copilot/responsible-use-of-github-copilot-features',
  },
]);

/**
 * The consent text for `COPILOT_CONSENT_VERSION` of `@marinoscar/kvox-contract/copilot`.
 *
 * @stability experimental
 */
export const COPILOT_CONSENT_COPY: CopilotConsentCopy = Object.freeze({
  version: COPILOT_CONSENT_VERSION,
  title: 'Use GitHub Copilot in KVox?',
  points: Object.freeze([
    {
      heading: 'What is sent to GitHub',
      text: 'When a KVox feature runs on GitHub Copilot, the text it works on, such as your note and transcript text, is sent to GitHub Copilot, which runs the model. Nothing is sent until you turn this on and sign in.',
    },
    {
      heading: 'Your own account',
      text: 'You sign in with your own GitHub account and Copilot subscription. KVox does not see your GitHub password or token. GitHub shows the permissions it asks for on its sign-in page; read them before you approve.',
    },
    {
      heading: 'GitHub’s terms apply',
      text: 'What GitHub does with the text it receives is set by GitHub’s terms and by your Copilot data settings on GitHub, not by KVox. Read the pages linked below before you agree.',
    },
    {
      heading: 'Your choice',
      text: 'This is opt-in and off by default. You can turn it off at any time in these settings, which also removes GitHub Copilot and its models from KVox.',
    },
    {
      heading: 'Ask is not available with Copilot',
      text: 'Ask needs a model that can use tools, and GitHub Copilot does not offer that here. Add an OpenAI key to keep Ask.',
    },
  ]),
  links: COPILOT_TERMS_LINKS,
  acceptLabel: 'Agree and turn on',
  acceptSelectedLabel: 'Agree and use GitHub Copilot',
} satisfies CopilotConsentCopy);

/**
 * The words of the Copilot settings card itself, outside the consent dialog.
 *
 * @stability experimental
 */
export interface CopilotProviderCopy {
  /** The card title. */
  displayName: string;
  /** The description under the title, beside the card's own enable switch. */
  description: string;
  /**
   * The description when the host offers the choice of provider itself (the card's `selected`
   * mode): the same sentence without the switch wording.
   */
  selectedDescription: string;
}

/**
 * The title and description of the Copilot settings card.
 *
 * @stability experimental
 */
export const COPILOT_PROVIDER_COPY: CopilotProviderCopy = Object.freeze({
  displayName: 'GitHub Copilot',
  description:
    'Run notes, knowledge extraction and name checks on your own GitHub Copilot subscription. Opt-in; off until you turn it on.',
  selectedDescription:
    'Run notes, knowledge extraction and name checks on your own GitHub Copilot subscription.',
} satisfies CopilotProviderCopy);

/**
 * The sentence about the runtime download shown in the consent text while the
 * runtime is missing.
 *
 * @param sizeText - The size to state; defaults to {@link COPILOT_RUNTIME_SIZE_TEXT}.
 * @stability experimental
 */
export function copilotRuntimeDownloadNote(sizeText: string = COPILOT_RUNTIME_SIZE_TEXT): string {
  return `GitHub Copilot needs a runtime of ${sizeText} that KVox downloads to this device the first time you use it.`;
}

/**
 * Why sign-in is not available yet, worded, or `null` when the runtime is ready.
 *
 * @remarks
 * Sign-in needs a working runtime. The card shows this under the disabled Sign
 * in button and its sign-in guard throws the same text, so a host that builds
 * its own UI on the headless entry says the same thing.
 *
 * @param runtime - The runtime part of the status.
 * @param sizeText - The download size to state while the runtime is missing; defaults to {@link COPILOT_RUNTIME_SIZE_TEXT}.
 * @stability experimental
 */
export function copilotSignInUnavailableReason(
  runtime: CopilotStatus['runtime'],
  sizeText: string = COPILOT_RUNTIME_SIZE_TEXT,
): string | null {
  switch (runtime.state) {
    case 'ready':
      return null;
    case 'downloading':
      return 'Wait for the Copilot runtime to finish downloading.';
    case 'error':
      return 'The Copilot runtime is not working. Download it again first.';
    default:
      return `Download the Copilot runtime first (${sizeText}).`;
  }
}

/**
 * The permanent `signInReason` strings a failed Copilot sign-in carries, worded.
 *
 * @remarks
 * Keyed by `CopilotSignInFailureReason` of `@marinoscar/kvox-ai/copilot`, whose
 * strings are permanent. Switch on the reason, never on an error message.
 *
 * @stability experimental
 */
export const COPILOT_SIGN_IN_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  sign_in_expired: 'The sign-in took too long and was cancelled. Try again.',
  sign_in_cancelled: 'Sign-in was cancelled.',
  sign_in_failed: 'GitHub did not finish the sign-in. Try again.',
  sign_in_not_started: 'No sign-in was in progress. Start it again.',
  sign_in_needs_plaintext_consent:
    'The Copilot runtime could only keep your sign-in in a plain file, which KVox does not allow, so the sign-in was cancelled.',
  sign_in_needs_account_selection: 'More than one GitHub account was found. Choose a single account and try again.',
  sign_in_needs_input: 'GitHub asked for something KVox cannot provide here. Try again.',
});

function readReason(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const direct = record['signInReason'];
  if (typeof direct === 'string') return direct;
  const details = record['details'];
  if (typeof details === 'object' && details !== null) {
    const nested = (details as Record<string, unknown>)['signInReason'];
    if (typeof nested === 'string') return nested;
  }
  return null;
}

/**
 * The sentence for a failed sign-in, or `null` when the error carries no known
 * `signInReason`.
 *
 * @remarks
 * Looks for `signInReason` on the error and on its `details`, which is where
 * `AiError` of the Copilot adapter puts it.
 *
 * @param error - Whatever the sign-in call threw.
 * @stability experimental
 */
export function copilotSignInReasonText(error: unknown): string | null {
  const reason = readReason(error);
  return reason ? (COPILOT_SIGN_IN_REASON_TEXT[reason] ?? null) : null;
}
