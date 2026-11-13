import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_CONFIG, AppConfig, configuration } from './configuration';
import { validateEnv } from './env.validation';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, load: [configuration] })],
  providers: [
    {
      provide: APP_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AppConfig => config.getOrThrow<AppConfig>('app'),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
