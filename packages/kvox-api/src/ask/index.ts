// The Ask slice of @marinoscar/kvox-api (issue #497, epic #491).
//
// Depends on `ports`, `core`, `graph`, `notes`, `search` and `transcripts` (row types). The
// one way in is `AskModule.forRoot(options)`; the rest of this file is what a host or a sibling
// slice imports. The classes are internal wiring (tagged `@internal`): a host configures them
// through `forRoot` and never instantiates them.
//
// Any `KVOX_AI` adapter that passes `describeKvoxPortsConformance` and `describeAskConformance`
// (`@marinoscar/kvox-api/ask/testing`) runs an Ask turn.

export { AskModule } from './ask.module.js';
export {
  ASK_MODULE_OPTIONS,
  resolveAskOptions,
  type AskLimitsOptions,
  type AskModuleOptions,
  type AskStreamOptions,
  type ResolvedAskOptions,
} from './ask.options.js';
export {
  ASK_CALL_TIMEOUT_MS,
  ASK_DERIVED_TITLE_MAX_CHARS,
  ASK_HISTORY_MESSAGES,
  ASK_MAX_OUTPUT_TOKENS,
  ASK_MAX_TOOL_CALLS_PER_STEP,
  ASK_MAX_TOOL_STEPS,
  ASK_RESPOND_MAX_RUNTIME_MS,
  ASK_RESPOND_PRIORITY,
  ASK_TOOL_RESULT_MAX_TOKENS,
  ASK_WALL_CLOCK_SOFT_MS,
} from './ask-limits.js';
export { ASK_MESSAGE_SUBJECT, ASK_RESPOND_JOB_TYPE } from './job-types.js';
export type { AskRespondPayload } from './job-types.js';
export {
  ASK_CONVERSATION_NOT_FOUND,
  ASK_MESSAGE_NOT_FOUND,
  AskAccessService,
} from './ask-access.service.js';
export { ASK_CONVERSATION_DELETED_ACTION, AskConversationsService } from './ask-conversations.service.js';
export { ASK_TURN_RUNNING } from './ask-messages.service.js';
export { AskUserDataService, type AskUserDataDeletion } from './user-data/ask-user-data.service.js';
export { ASK_STREAM_TUNING, type AskStreamTuning } from './stream/ask-message-stream.service.js';

// The data layer: row types and the narrowed database client the slice injects.
export type {
  AskConversationRow,
  AskErrorClassValue,
  AskFinishReasonValue,
  AskMessageDbRow,
  AskMessageRoleValue,
  AskMessageStatusValue,
  KvoxAskDb,
  KvoxAskDelegates,
  KvoxAskTx,
} from './data/ask-db.js';
