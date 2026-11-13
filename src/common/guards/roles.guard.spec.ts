import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleName } from '@prisma/client';
import { AppException } from '../errors/app.exception';
import { RolesGuard } from './roles.guard';

function check(required: RoleName[] | undefined, userRoles?: RoleName[]): boolean {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user: userRoles ? { roles: userRoles } : undefined }) }),
  } as unknown as ExecutionContext;
  return new RolesGuard(reflector).canActivate(context);
}

describe('RolesGuard', () => {
  it('allows routes without a role requirement', () => {
    expect(check(undefined, [RoleName.USER])).toBe(true);
  });

  it('allows a user holding one of the required roles', () => {
    expect(check([RoleName.ADMIN, RoleName.FINANCE], [RoleName.USER, RoleName.FINANCE])).toBe(true);
  });

  it('allows SUPER_ADMIN everywhere', () => {
    expect(check([RoleName.FINANCE], [RoleName.SUPER_ADMIN])).toBe(true);
  });

  it('forbids users without a required role, and requests without a user', () => {
    expect(() => check([RoleName.ADMIN], [RoleName.USER])).toThrow(AppException);
    expect(() => check([RoleName.ADMIN], [RoleName.SUPPORT, RoleName.FINANCE])).toThrow(AppException);
    expect(() => check([RoleName.ADMIN])).toThrow(AppException);
  });
});
