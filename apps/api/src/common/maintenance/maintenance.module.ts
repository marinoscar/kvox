import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SettingsModule } from '../../settings/settings.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceGuard } from './maintenance.guard';
import { MaintenanceModeService } from './maintenance-mode.service';

/**
 * Maintenance mode (#257, epic #254).
 *
 * WHY THIS REGISTERS ITS OWN `JwtModule` INSTEAD OF IMPORTING `AuthModule`.
 * `AuthModule` does export `JwtModule`, so importing it would work today. It
 * also pulls in `UsersModule`, `AllowlistModule`, `PatModule`,
 * `NotificationsModule`, `PassportModule` and both Passport strategies — the
 * whole authentication graph — and this module provides a guard that runs in
 * front of EVERY request in the application. A global guard that depends on the
 * entire auth graph is one refactor away from a circular import, and the shape
 * of that failure is the application not booting at all.
 *
 * Registering `JwtModule` here against the SAME `jwt.secret` costs one small
 * dynamic module and buys a dependency edge that goes exactly one way:
 * maintenance -> settings, and maintenance -> jwt. Nothing in the auth graph
 * depends on this module, and this module depends on none of it.
 * `maintenance.module.spec.ts` asserts that as an acceptance criterion rather
 * than leaving it as a convention somebody restores `AuthModule` into later.
 *
 * `JwtModule` is deliberately NOT re-exported. `AuthModule` already exports one
 * into the root context, and a second exported `JwtService` binding there could
 * shadow it — including for the token-signing helpers the test suite resolves
 * from the root injector. This one stays local to the guard that uses it.
 *
 * The `secret` fallback matches `auth/strategies/jwt.strategy.ts` exactly. It
 * has to: a guard that verified against a different key than the one the
 * application signs with would silently decide that no token belongs to an
 * admin, and `allowAdmins` would stop working with nothing to show for it.
 */
@Module({
  imports: [
    SettingsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret') || 'fallback-secret',
      }),
    }),
  ],
  controllers: [MaintenanceController],
  providers: [MaintenanceModeService, MaintenanceGuard],
  // The guard is exported so `app.module.ts` can alias it to `APP_GUARD` with
  // `useExisting` — which keeps the global registration visible in the module
  // that owns the application, while the instance itself is still constructed
  // here, in the context that has its `JwtService`.
  exports: [MaintenanceModeService, MaintenanceGuard],
})
export class MaintenanceModule {}
