import { execSync } from 'node:child_process';
import './env';

/** Applies all migrations to the dedicated test database before the suite runs. */
export default function globalSetup(): void {
  if (!/test/i.test(new URL(process.env.DATABASE_URL as string).pathname)) {
    throw new Error('Refusing to run integration tests against a database whose name does not contain "test"');
  }
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: process.env });
}
