import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { GraphModule } from '../graph/graph.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AskAccessService } from './ask-access.service';
import { AskConversationsController } from './ask-conversations.controller';
import { AskConversationsService } from './ask-conversations.service';
import { AskMessagesController } from './ask-messages.controller';
import { AskMessagesService } from './ask-messages.service';
import { AskRespondHandler } from './handlers/ask-respond.handler';
import { ASK_USER_DATA_HOOKS } from './ask.user-data';
import { AskUserDataHooks } from './ask.user-data.hooks';
import { AskMessageStreamController } from './stream/ask-message-stream.controller';
import { ASK_STREAM_TUNING, AskMessageStreamService } from './stream/ask-message-stream.service';
import { AskToolsModule } from './tools/ask-tools.module';

// =============================================================================
// AskModule (issue #376, epic #348; docs/specs/ontology.md §21)
// =============================================================================
//
// Saved conversations with the read-only graph agent. This issue lands the
// storage, `AskAccessService` and the CRUD routes; #378 adds posting a message
// and the `ask.respond` job, #379 the stream — both HERE. `GraphModule`
// supplies `GraphAccessService` (scope validation); the edge runs one way.
// `AskToolsModule` (#377) supplies the read-only `AskToolset` #378's job runs.
// #378: `JobsModule` (enqueue + the handler registry) and `AiModule` (the
// task-model resolver and the asker's own key) for posting and answering.
// #379's `AskMessageStreamController`/`AskMessageStreamService` are a read-only
// view over `ask_messages`; `ASK_STREAM_TUNING` is `{}` so the defaults ship.
// =============================================================================

@Module({
  imports: [
    PrismaModule,
    GraphModule,
    AskToolsModule,
    AiModule,
  ],
  providers: [
    AskAccessService,
    AskConversationsService,
    AskMessagesService,
    AskRespondHandler,
    { provide: ASK_USER_DATA_HOOKS, useClass: AskUserDataHooks },
    AskMessageStreamService,
    { provide: ASK_STREAM_TUNING, useValue: {} },
  ],
  controllers: [
    AskConversationsController,
    AskMessagesController,
    AskMessageStreamController,
  ],
  exports: [AskAccessService, AskConversationsService],
})
export class AskModule {}
