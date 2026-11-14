import { RoleName } from '@prisma/client';
import { isStaff } from '../../common/roles';

export interface Account {
  id: string;
  roles: readonly RoleName[];
}

/**
 * Why `actor` may not manage `target` (status, password, sessions, roles), or null when they may.
 * Nobody manages their own account, and only a SUPER_ADMIN manages staff accounts: otherwise an
 * ADMIN could block or take over a more privileged account.
 */
export function manageRefusal(actor: Account, target: Account): string | null {
  if (actor.id === target.id) return 'You cannot perform this action on your own account';
  if (isStaff(target.roles) && !actor.roles.includes(RoleName.SUPER_ADMIN)) {
    return 'Only a SUPER_ADMIN can manage a staff account';
  }
  return null;
}

/** Staff roles in a fixed order without repeats, so two role sets can be compared and stored consistently. */
export function normalizeStaffRoles(roles: readonly RoleName[]): RoleName[] {
  const order: RoleName[] = [RoleName.SUPPORT, RoleName.FINANCE, RoleName.ADMIN, RoleName.SUPER_ADMIN];
  return order.filter((role) => roles.includes(role));
}

const PASSWORD_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const PASSWORD_DIGITS = '23456789';
export const TEMPORARY_PASSWORD_LENGTH = 14;

/**
 * A random password staff can read out over the phone: no look-alike characters (0/O, 1/l/I).
 * Always has a letter and a digit, as the password rules require. `randomInt(n)` must be uniform in [0, n).
 */
export function temporaryPassword(randomInt: (max: number) => number): string {
  const alphabet = PASSWORD_LETTERS + PASSWORD_DIGITS;
  for (;;) {
    let password = '';
    for (let i = 0; i < TEMPORARY_PASSWORD_LENGTH; i++) password += alphabet[randomInt(alphabet.length)];
    if (/[A-Za-z]/.test(password) && /[0-9]/.test(password)) return password;
  }
}
