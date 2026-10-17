// The host-neutral half of the ask slice: the API clients, the answer stream,
// the hooks over them and the pure helpers (error copy, citation parsing, model
// choices, suggestions). No component, no `@mui/*`, no router and no
// `react-markdown` (the citation plugin walks the tree by hand and imports only
// a type).

// The API clients. Each call takes the `KvoxWebHost` first.
export * from './clients/ask.js';
export * from './clients/askAiConfig.js';
export * from './clients/askStream.js';

// The hooks.
export * from './hooks/useAskAiConfig.js';
export * from './hooks/useAskConversation.js';
export * from './hooks/useAskConversations.js';
export * from './hooks/useAskStream.js';

// Pure helpers the screens share.
export * from './utils/askErrorCopy.js';
export * from './utils/askModels.js';
export * from './utils/entityAskSuggestions.js';
export * from './utils/remarkAskCitations.js';
