import { Module } from '@nestjs/common';

import { GraphModule } from '../graph/graph.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AskAccessService } from './ask-access.service';
import { AskConversationsController } from './ask-conversations.controller';
import { AskConversationsService } from './ask-conversations.service';
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
// =============================================================================

@Module({
  imports: [PrismaModule, GraphModule, AskToolsModule],
  providers: [AskAccessService, AskConversationsService],
  controllers: [AskConversationsController],
  exports: [AskAccessService, AskConversationsService],
})
export class AskModule {}
