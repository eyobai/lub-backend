import { RoleName } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { manageRefusal, normalizeStaffRoles, temporaryPassword, TEMPORARY_PASSWORD_LENGTH } from './user-rules';

const account = (id: string, ...roles: RoleName[]) => ({ id, roles });

describe('manageRefusal', () => {
  it('lets staff manage an ordinary user', () => {
    for (const role of [RoleName.SUPPORT, RoleName.ADMIN, RoleName.SUPER_ADMIN]) {
      expect(manageRefusal(account('a', role), account('u', RoleName.USER))).toBeNull();
      expect(manageRefusal(account('a', role), account('u'))).toBeNull();
    }
  });

  it('never lets anyone manage their own account', () => {
    expect(manageRefusal(account('a', RoleName.SUPER_ADMIN), account('a', RoleName.SUPER_ADMIN))).toMatch(/own/);
    expect(manageRefusal(account('a', RoleName.ADMIN), account('a', RoleName.ADMIN))).toMatch(/own/);
  });

  it('lets only a SUPER_ADMIN manage staff, whatever other roles they hold', () => {
    for (const target of [RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN, RoleName.SUPER_ADMIN]) {
      expect(manageRefusal(account('a', RoleName.ADMIN), account('s', RoleName.USER, target))).toMatch(/SUPER_ADMIN/);
      expect(manageRefusal(account('a', RoleName.SUPPORT), account('s', target))).toMatch(/SUPER_ADMIN/);
      expect(manageRefusal(account('a', RoleName.SUPER_ADMIN), account('s', target))).toBeNull();
    }
  });
});

describe('normalizeStaffRoles', () => {
  it('drops USER and repeats and keeps a fixed order', () => {
    expect(
      normalizeStaffRoles([RoleName.ADMIN, RoleName.USER, RoleName.SUPPORT, RoleName.ADMIN, RoleName.SUPER_ADMIN]),
    ).toEqual([RoleName.SUPPORT, RoleName.ADMIN, RoleName.SUPER_ADMIN]);
    expect(normalizeStaffRoles([RoleName.USER])).toEqual([]);
  });
});

describe('temporaryPassword', () => {
  it('meets the password rules and avoids look-alike characters', () => {
    for (let i = 0; i < 200; i++) {
      const password = temporaryPassword(randomInt);
      expect(password).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      expect(password).toMatch(/[A-Za-z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).not.toMatch(/[^A-Za-z0-9]|[01IOilo]/);
    }
  });

  it('retries until the password has both a letter and a digit', () => {
    // 14 letters first (index 0 = "A"), then indexes that include a digit (the last alphabet entry).
    const draws = [...Array<number>(TEMPORARY_PASSWORD_LENGTH).fill(0), ...Array<number>(13).fill(0), 53];
    const password = temporaryPassword(() => draws.shift() ?? 0);
    expect(password).toBe('AAAAAAAAAAAAA9');
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => temporaryPassword(randomInt)));
    expect(seen.size).toBe(500);
  });
});
