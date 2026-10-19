// The MUI half of the copilot slice: the GitHub Copilot settings card, built on
// `AccountSignInProviderCard` of `@marinoscar/platform-web/ai/ui`, with its
// consent body, sign-in dialog and runtime section. The card makes no network
// call; pair it with `useCopilotProvider` from `@marinoscar/kvox-web/copilot/headless`.

export { CopilotProviderCard } from './CopilotProviderCard.js';
export type { CopilotProviderCardProps } from './CopilotProviderCard.js';
export { CopilotConsentBody } from './CopilotConsentBody.js';
export type { CopilotConsentBodyProps } from './CopilotConsentBody.js';
export { CopilotSignInDialog } from './CopilotSignInDialog.js';
export type { CopilotSignInDialogProps } from './CopilotSignInDialog.js';
export { CopilotRuntimeSection } from './CopilotRuntimeSection.js';
export type { CopilotRuntimeSectionProps } from './CopilotRuntimeSection.js';
