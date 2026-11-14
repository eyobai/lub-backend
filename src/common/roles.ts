import { RoleName } from '@prisma/client';

/** Back-office roles. An account holding any of them is a staff account. */
export const STAFF_ROLES: readonly RoleName[] = [
  RoleName.SUPPORT,
  RoleName.FINANCE,
  RoleName.ADMIN,
  RoleName.SUPER_ADMIN,
];

export const isStaff = (roles: readonly RoleName[]): boolean => roles.some((role) => STAFF_ROLES.includes(role));
