import { Module } from '@nestjs/common';
import { AboutController } from './about.controller';
import { AboutService } from './about.service';

/**
 * The About surface (issue #124, epic #118): one read-only route reporting
 * what is deployed here.
 *
 * No imports: `PrismaModule` is `@Global`, and the guards `@Auth()` attaches
 * resolve their own dependencies from the two `@Global` credential modules
 * (`PatModule`, `NodeCredentialModule`) registered in `app.module.ts`. Nothing
 * here is exported — no other module has a reason to ask the About service
 * anything.
 */
@Module({
  controllers: [AboutController],
  providers: [AboutService],
})
export class AboutModule {}
