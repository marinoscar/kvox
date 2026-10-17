import { Module, type DynamicModule } from '@nestjs/common';

import { documentKvoxAuth } from '../core/index.js';
import { GraphModule } from '../graph/index.js';
import { NotesModule } from '../notes/index.js';
import { SearchModule } from '../search/index.js';
import { AskAccessService } from './ask-access.service.js';
import { AskConversationsController } from './ask-conversations.controller.js';
import { AskConversationsService } from './ask-conversations.service.js';
import { AskMessagesController } from './ask-messages.controller.js';
import { AskMessagesService } from './ask-messages.service.js';
import { ASK_MODULE_OPTIONS, resolveAskOptions, type AskModuleOptions } from './ask.options.js';
import { AskRespondHandler } from './handlers/ask-respond.handler.js';
import { AskMessageStreamController } from './stream/ask-message-stream.controller.js';
import { ASK_STREAM_TUNING, AskMessageStreamService } from './stream/ask-message-stream.service.js';
import { ASK_TOOL_PROVIDERS } from './tools/ask-tool-providers.js';
import { AskToolset } from './tools/ask-toolset.js';
import { AskUserDataService } from './user-data/ask-user-data.service.js';

// =============================================================================
// AskModule (issue #376, epic #348; docs/specs/ontology.md §21; the package slice of issue #497, epic #491)
// =============================================================================
//
// Saved conversations with the read-only graph agent: the storage, `AskAccessService` and the
// CRUD routes (#376), posting a message and the `ask.respond` job (#378), and the SSE view over
// the durable answer (#379), with the read-only toolset (#377) the job runs.
//
// It is built over ports only. The host's database, queue, audit trail, identity and model
// arrive through the `KVOX_*` tokens of `KvoxPortsModule` (global); the peer slices' modules
// are options of `forRoot`. The model, the asker's own key and the streamed tool loop come from
// `KVOX_AI.chat`: any host whose AI adapter passes the ports conformance kit runs an Ask turn.
//
// WHAT IT IMPORTS, AND WHY EACH ONE:
//
//   • the graph slice: access (scope validation), the read services the seven tools call, the
//     entity brief and the AI run resolver (the one place a refused model becomes a 409).
//   • the search slice: `SearchService` (the `search` tool's document leg, spec §9.4) and the host's
//     transcript-visibility rule.
//   • the notes slice: shared with the graph module (it imports it itself); passed through so the
//     same configured instance is used.
//
// ⚠ ALL OF THEM ARE IMPORTED, NEVER PROVIDED AGAIN: a peer slice's providers are reached through
// its module, so a handler registers once however many slices import it.
//
// NO WRITE SERVICE IS IMPORTED: the agent is read-only end to end. The conformance suite scans
// the slice's sources for the graph's write services.
// =============================================================================

/**
 * The Ask agent: saved conversations, one queue job per turn, a read-only tool loop over the
 * graph, and an SSE view over the durable answer.
 *
 * @stability experimental
 */
@Module({})
export class AskModule {
  /**
   * Builds the module over the host's ports.
   *
   * @param options - the turn's caps (lowered only), the stream's pacing and the peer modules.
   * @returns the dynamic module; it exports the access and conversation services and {@link AskUserDataService}.
   * @throws Error when a cap is above the product's own value.
   */
  static forRoot(options: AskModuleOptions = {}): DynamicModule {
    const resolved = resolveAskOptions(options);
    const controllers = [AskConversationsController, AskMessagesController, AskMessageStreamController];

    // Now that the routes are known, describe them in the API document the way the host chose.
    documentKvoxAuth(controllers);

    return {
      module: AskModule,
      global: false,
      imports: [
        ...(options.imports ?? []),
        // The peer slices. The application imports each itself; pass the very same objects here.
        options.peers?.graph ?? GraphModule.forRoot(),
        options.peers?.notes ?? NotesModule.forRoot(),
        options.peers?.search ?? SearchModule.forRoot(),
      ],
      controllers,
      providers: [
        { provide: ASK_MODULE_OPTIONS, useValue: resolved },
        AskAccessService,
        AskConversationsService,
        AskMessagesService,
        ...ASK_TOOL_PROVIDERS,
        AskToolset,
        AskRespondHandler,
        AskMessageStreamService,
        // The stream's pacing, from the options; a spec overrides the token to drive the clock.
        {
          provide: ASK_STREAM_TUNING,
          useValue: { pollIntervalMs: resolved.stream.pollIntervalMs, heartbeatIntervalMs: resolved.stream.heartbeatMs },
        },
        AskUserDataService,
      ],
      exports: [ASK_MODULE_OPTIONS, AskAccessService, AskConversationsService, AskUserDataService],
    };
  }
}
