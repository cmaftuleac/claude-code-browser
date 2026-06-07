import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleService } from './google.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { FineguideController } from './fineguide.controller';
import { FineguideService } from './fineguide.service';

@Module({
  imports: [
    // registerAsync so the secret/TTL are read AFTER ConfigModule loads (.env), not at import time.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('CCB_JWT_SECRET') ?? 'dev-insecure-secret-change-me',
        signOptions: {
          // jsonwebtoken types expiresIn as ms `StringValue` (template-literal); a
          // plain config string needs the cast (the value e.g. '7d' is valid at runtime).
          expiresIn: (config.get<string>('CCB_JWT_TTL') ?? '7d') as JwtSignOptions['expiresIn'],
          algorithm: 'HS256',
        },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController, FineguideController],
  providers: [AuthService, GoogleService, JwtAuthGuard, FineguideService],
})
export class AuthModule {}
