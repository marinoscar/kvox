import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { CommonModule } from '../common/common.module';
import { AllowlistModule } from '../allowlist/allowlist.module';
import { PatModule } from '../pat/pat.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokenCleanupTask } from './tasks/token-cleanup.task';
import { TokenCleanupHandler } from './handlers/token-cleanup.handler';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [
    // Passport configuration
    PassportModule.register({ defaultStrategy: 'jwt' }),

    // JWT configuration
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
        signOptions: {
          expiresIn: `${config.get<number>('jwt.accessTtlMinutes', 15)}m`,
        },
      }),
    }),

    // Common module for AdminBootstrapService
    CommonModule,

    // Allowlist module for email allowlist checks
    AllowlistModule,

    // PAT module for Personal Access Token validation in JwtAuthGuard
    PatModule,

    // Notifications: `handleGoogleLogin` raises `user.welcome` the first time
    // a user record is created through OAuth (#128).
    NotificationsModule,

    // #353 (epic #345): the nightly token cleanup is a queue job now, so this
    // module needs `JobsService` to enqueue it and `JobHandlerRegistry` for
    // the handler to register itself with. One-way — nothing in `JobsModule`
    // imports auth.
    JobsModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    GoogleStrategy,
    JwtStrategy,
    TokenCleanupTask,
    TokenCleanupHandler,
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
