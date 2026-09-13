// =============================================================================
// NodeCredentialModule — deliberately tiny, deliberately @Global (#267, #254)
// =============================================================================
//
// It imports `PrismaModule` and nothing else, mirroring `PatModule` exactly.
// Both properties are load-bearing.
//
// -----------------------------------------------------------------------------
// WHY @Global
// -----------------------------------------------------------------------------
// `JwtAuthGuard` is instantiated everywhere `@Auth()` appears — which is to
// say, in nearly every feature module in this application. It now injects
// `NodeCredentialService` alongside `PatService`. Without `@Global`, every one
// of those modules would have to import this one, and a module that forgot
// would fail at boot with a DI error naming a guard rather than the missing
// import. `PatModule` solved the identical problem the identical way, and
// the guard's two dependencies behaving differently would be a trap for the
// next person to touch either.
//
// -----------------------------------------------------------------------------
// WHY THIS IS NOT PART OF THE NODES MODULE #268 WILL ADD
// -----------------------------------------------------------------------------
// #268 brings the node control plane: register, heartbeat, claim, lease
// renewal, deregistration — a module with real dependencies (the jobs
// services, settings, config, the clock). It is tempting to file "node
// credentials" under "nodes" on the strength of the shared word.
//
// Doing that would put ALL of that weight behind a guard that runs on every
// authenticated request in the application, and it would very likely create a
// cycle: a nodes module that depends on the jobs module, whose controllers use
// `@Auth()`, whose guard depends on the nodes module. Nest would report that
// as a circular dependency at boot, and the fix under pressure is always the
// wrong one (`forwardRef`, which makes the cycle invisible rather than
// absent).
//
// So the split is by DEPENDENCY WEIGHT, not by topic: the guard's dependency
// stays a service over one Prisma model, and the control plane is free to grow
// as heavy as it needs to in its own module. Same directory, so the two are
// obviously related; different modules, so the graph stays acyclic.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NodeCredentialController } from './node-credential.controller';
import { NodeCredentialService } from './node-credential.service';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [NodeCredentialController],
  providers: [NodeCredentialService],
  exports: [NodeCredentialService],
})
export class NodeCredentialModule {}
