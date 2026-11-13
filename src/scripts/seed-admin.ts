import { PrismaClient, RoleName } from '@prisma/client';
import { PasswordService } from '../modules/auth/password.service';

/**
 * Creates (or promotes) the bootstrap SUPER_ADMIN from SEED_ADMIN_PHONE / SEED_ADMIN_PASSWORD.
 * Idempotent, and never changes the password of an account that already exists.
 */
async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the process environment.
  }
  const phoneNumber = process.env.SEED_ADMIN_PHONE;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!phoneNumber || !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    throw new Error('SEED_ADMIN_PHONE must be set to an E.164 phone number, e.g. +251911234567');
  }
  if (!password || password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be set and at least 12 characters long');
  }

  const prisma = new PrismaClient();
  try {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.SUPER_ADMIN } });
    const existing = await prisma.user.findUnique({ where: { phoneNumber } });
    const user =
      existing ??
      (await prisma.user.create({
        data: {
          phoneNumber,
          passwordHash: await new PasswordService().hash(password),
          phoneVerifiedAt: new Date(),
          profile: { create: { fullName: 'Super Admin' } },
        },
      }));
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      create: { userId: user.id, roleId: role.id },
      update: {},
    });
    console.log(`${existing ? 'Existing user promoted to' : 'Created'} SUPER_ADMIN ${phoneNumber}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
