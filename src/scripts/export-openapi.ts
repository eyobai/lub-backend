import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { buildOpenApiDocument, configureApp } from '../app.setup';

/** Writes the OpenAPI document to docs/openapi.json (or the path given as the first argument). */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app);
  const target = resolve(process.argv[2] ?? 'docs/openapi.json');
  writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`);
  await app.close();
  console.log(`OpenAPI document written to ${target}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
