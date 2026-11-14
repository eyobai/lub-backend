import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = configureApp(app);
  if (config.swaggerEnabled) setupSwagger(app);

  await app.listen(config.port);
  logger.log(
    `API listening on port ${config.port} (${config.env})${config.swaggerEnabled ? '; docs at /docs' : ''}`,
    'Bootstrap',
  );
}

void bootstrap();
