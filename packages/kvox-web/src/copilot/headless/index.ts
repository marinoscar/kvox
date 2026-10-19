// The host-neutral half of the copilot slice: the consent text as data, the
// sign-in failure wording, the capability rows and `useCopilotProvider` over a
// host's `CopilotProviderPort`. No component and no `@mui/*`: a host with
// another design system builds its own UI on this entry.

export * from './copilotCapabilities.js';
export * from './copilotCopy.js';
export * from './useCopilotProvider.js';
