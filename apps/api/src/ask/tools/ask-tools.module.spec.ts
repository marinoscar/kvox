// =============================================================================
// AskToolsModule resolves (#377)
// =============================================================================
//
// The one thing a unit spec with hand-built mocks cannot prove: that Nest can
// construct `AskToolset` and its seven tools from the modules
// `AskToolsModule` imports — i.e. that every read service a tool injects is
// actually EXPORTED by `GraphModule`/`SearchModule`. `compile()` resolves the
// whole provider graph without running lifecycle hooks, so nothing here polls,
// schedules or reaches a database.
// =============================================================================

import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import configuration from '../../config/configuration';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { ASK_TOOL_NAMES, AskToolset } from './ask-toolset';
import { AskToolsModule } from './ask-tools.module';

describe('AskToolsModule (real module graph)', () => {
  let moduleRef: TestingModule | undefined;

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('compiles and provides AskToolset with all seven tools', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        EventEmitterModule.forRoot(),
        PrismaModule,
        AskToolsModule,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    const toolset = moduleRef.get(AskToolset);
    expect(toolset).toBeInstanceOf(AskToolset);
    expect(toolset.definitions().map((d) => d.name)).toEqual([...ASK_TOOL_NAMES]);
  });
});
