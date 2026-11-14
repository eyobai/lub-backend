import { RoleName } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';
const NEW_PASSWORD = 'An0therPassw0rd';
const REASON = { reason: 'Requested by the account owner' };
const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

interface Account {
  id: string;
  token: string;
  refreshToken: string;
  phoneNumber: string;
}

describe('Admin management', () => {
  let t: TestApp;
  let superAdmin: Account;
  let admin: Account;
  let support: Account;
  let finance: Account;
  let user: Account;
  let phoneCounter = 0;

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    superAdmin = await account({ roles: [RoleName.SUPER_ADMIN] });
    admin = await account({ roles: [RoleName.ADMIN] });
    support = await account({ roles: [RoleName.SUPPORT] });
    finance = await account({ roles: [RoleName.FINANCE] });
    user = await account({ fullName: 'Abebe Kebede' });
  });

  async function account(
    options: { roles?: RoleName[]; fullName?: string; balanceMinor?: bigint } = {},
  ): Promise<Account> {
    const phoneNumber = `+2519${String(60000000 + ++phoneCounter)}`;
    const res = await t
      .post('/auth/register', { phoneNumber, password: PASSWORD, fullName: options.fullName })
      .expect(201);
    for (const name of options.roles ?? []) {
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: role.id } });
    }
    if (options.balanceMinor) {
      await t.app.get(WalletService).deposit({ userId: res.body.userId, amountMinor: options.balanceMinor });
    }
    return {
      id: res.body.userId,
      token: res.body.tokens.accessToken,
      refreshToken: res.body.tokens.refreshToken,
      phoneNumber,
    };
  }

  const login = (phoneNumber: string, password = PASSWORD) => t.post('/auth/login', { phoneNumber, password });
  const act = (target: Account, action: string, by: Account, body: object = REASON) =>
    t.post(`/admin/users/${target.id}/${action}`, body, by.token);
  const setRoles = (target: Account, roles: string[], by: Account = superAdmin) =>
    t.put(`/admin/users/${target.id}/roles`, { roles, ...REASON }, by.token);
  const rolesOf = async (id: string) =>
    (await t.prisma.userRole.findMany({ where: { userId: id }, include: { role: true } })).map((r) => r.role.name);
  const audits = (action: string) => t.prisma.auditLog.findMany({ where: { action } });

  describe('user list and detail', () => {
    it('lists users newest first for SUPPORT, FINANCE, ADMIN and SUPER_ADMIN', async () => {
      for (const staff of [support, finance, admin, superAdmin]) {
        const res = await t.get('/admin/users', staff.token).expect(200);
        expect(res.body).toMatchObject({ total: 5, page: 1, limit: 20 });
        expect(res.body.items[0]).toEqual({
          id: user.id,
          phoneNumber: user.phoneNumber,
          fullName: 'Abebe Kebede',
          email: null,
          status: 'ACTIVE',
          statusReason: null,
          roles: ['USER'],
          phoneVerified: false,
          mustChangePassword: false,
          lastLoginAt: expect.any(String),
          createdAt: expect.any(String),
        });
      }
    });

    it('is closed to ordinary users and to anonymous callers', async () => {
      await t.get('/admin/users', user.token).expect(403);
      await t.get(`/admin/users/${user.id}`, user.token).expect(403);
      await t.get('/admin/users').expect(401);
    });

    it('never exposes the password hash', async () => {
      const list = await t.get('/admin/users', admin.token).expect(200);
      const detail = await t.get(`/admin/users/${user.id}`, admin.token).expect(200);
      expect(JSON.stringify([list.body, detail.body])).not.toMatch(/argon2|passwordHash/i);
    });

    it('searches by phone number as people type it, by name, and filters by status and role', async () => {
      const local = `0${user.phoneNumber.slice(4)}`;
      for (const search of [local, user.phoneNumber, user.phoneNumber.slice(4), 'abebe', 'KEBEDE']) {
        const res = await t.get(`/admin/users?search=${encodeURIComponent(search)}`, support.token).expect(200);
        expect(res.body.items.map((u: { id: string }) => u.id)).toEqual([user.id]);
      }
      expect((await t.get('/admin/users?search=nobody', support.token).expect(200)).body.total).toBe(0);

      const byRole = await t.get('/admin/users?role=FINANCE', support.token).expect(200);
      expect(byRole.body.items.map((u: { id: string }) => u.id)).toEqual([finance.id]);

      await act(user, 'suspend', admin).expect(200);
      const suspended = await t.get('/admin/users?status=SUSPENDED', support.token).expect(200);
      expect(suspended.body.items.map((u: { id: string }) => u.id)).toEqual([user.id]);
      expect((await t.get('/admin/users?status=ACTIVE', support.token).expect(200)).body.total).toBe(4);
    });

    it('pages and validates its query', async () => {
      const page = await t.get('/admin/users?page=2&limit=2', admin.token).expect(200);
      expect(page.body).toMatchObject({ total: 5, page: 2, limit: 2 });
      expect(page.body.items).toHaveLength(2);

      await t.get('/admin/users?status=DELETED', admin.token).expect(400);
      await t.get('/admin/users?role=OWNER', admin.token).expect(400);
      await t.get('/admin/users?search=a', admin.token).expect(400);
      await t.get('/admin/users?limit=1000', admin.token).expect(400);
    });

    it('shows sessions, bids and wins in the detail', async () => {
      await login(user.phoneNumber).expect(200);
      const res = await t.get(`/admin/users/${user.id}`, support.token).expect(200);
      expect(res.body).toMatchObject({
        id: user.id,
        activeSessions: 2,
        bidCount: 0,
        winCount: 0,
        passwordChangedAt: null,
        lastLoginAt: expect.any(String),
      });

      await t.get(`/admin/users/${randomUUID()}`, support.token).expect(404);
      await t.get('/admin/users/not-a-uuid', support.token).expect(400);
    });
  });

  describe('suspend, block and reactivate', () => {
    it('suspends: the user is signed out at once and cannot sign in or refresh', async () => {
      const res = await act(user, 'suspend', admin, { reason: 'Chargeback under review' }).expect(200);
      expect(res.body).toMatchObject({
        id: user.id,
        status: 'SUSPENDED',
        statusReason: 'Chargeback under review',
        activeSessions: 0,
      });

      await t.get('/auth/me', user.token).expect(401);
      expect((await login(user.phoneNumber).expect(403)).body.error).toBe('ACCOUNT_SUSPENDED');
      await t.post('/auth/refresh', { refreshToken: user.refreshToken }).expect(401);

      const [audit] = await audits('user.suspend');
      expect(audit).toMatchObject({
        actorId: admin.id,
        actorType: 'ADMIN',
        entityType: 'user',
        entityId: user.id,
        before: { status: 'ACTIVE', statusReason: null },
        after: { status: 'SUSPENDED', statusReason: 'Chargeback under review' },
        metadata: { reason: 'Chargeback under review' },
      });
    });

    it('blocks with its own error code', async () => {
      await act(user, 'block', admin, { reason: 'Confirmed fraud' }).expect(200);
      await t.get('/auth/me', user.token).expect(401);
      expect((await login(user.phoneNumber).expect(403)).body.error).toBe('ACCOUNT_BLOCKED');
      expect(await audits('user.block')).toHaveLength(1);
    });

    it('reactivates: the user can sign in again and the reason is cleared', async () => {
      await act(user, 'block', admin).expect(200);
      const res = await act(user, 'reactivate', admin, { reason: 'Appeal accepted' }).expect(200);
      expect(res.body).toMatchObject({ status: 'ACTIVE', statusReason: null });

      // Old sessions stay dead; a fresh sign-in works.
      await t.get('/auth/me', user.token).expect(401);
      const fresh = await login(user.phoneNumber).expect(200);
      await t.get('/auth/me', fresh.body.tokens.accessToken).expect(200);

      const [audit] = await audits('user.reactivate');
      expect(audit).toMatchObject({
        before: { status: 'BLOCKED' },
        after: { status: 'ACTIVE', statusReason: null },
        metadata: { reason: 'Appeal accepted' },
      });
    });

    it('moves straight from suspended to blocked, and refuses a change to the current status', async () => {
      await act(user, 'suspend', admin).expect(200);
      expect((await act(user, 'suspend', admin).expect(409)).body.error).toBe('ACCOUNT_INVALID_STATE');
      await act(user, 'block', admin).expect(200);
      await act(user, 'reactivate', admin).expect(200);
      expect((await act(user, 'reactivate', admin).expect(409)).body.error).toBe('ACCOUNT_INVALID_STATE');
      expect(await t.prisma.auditLog.count({ where: { action: { startsWith: 'user.' } } })).toBe(3);
    });

    it('requires a reason and an existing user', async () => {
      await act(user, 'suspend', admin, {}).expect(400);
      await act(user, 'suspend', admin, { reason: 'no' }).expect(400);
      await t.post(`/admin/users/${randomUUID()}/suspend`, REASON, admin.token).expect(404);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('ACTIVE');
    });

    it('is ADMIN only', async () => {
      for (const actor of [support, finance, user]) {
        for (const action of ['suspend', 'block', 'reactivate']) await act(user, action, actor).expect(403);
      }
      await t.post(`/admin/users/${user.id}/suspend`, REASON).expect(401);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('ACTIVE');
    });

    it('stops a suspended bidder from bidding', async () => {
      const bidder = await account({ balanceMinor: 100000n });
      const auctionId = await activeAuction();
      await act(bidder, 'suspend', admin).expect(200);
      await t
        .post(`/auctions/${auctionId}/bids`, { amountsMinor: ['100'] }, bidder.token)
        .set('Idempotency-Key', randomUUID())
        .expect(401);
      expect(await t.prisma.bid.count()).toBe(0);
    });
  });

  describe('privilege escalation', () => {
    it('does not let an ADMIN suspend, block, reset or sign out any staff account', async () => {
      const otherAdmin = await account({ roles: [RoleName.ADMIN] });
      for (const target of [support, finance, otherAdmin, superAdmin]) {
        for (const action of ['suspend', 'block', 'reset-password', 'revoke-sessions']) {
          const res = await act(target, action, admin).expect(403);
          expect(res.body.message).toMatch(/SUPER_ADMIN/);
        }
        await t.get('/auth/me', target.token).expect(200);
        await login(target.phoneNumber).expect(200);
      }
      expect(await t.prisma.auditLog.count()).toBe(0);
    });

    it('does not let SUPPORT take over a staff account through a password reset', async () => {
      for (const target of [finance, admin, superAdmin]) {
        await act(target, 'reset-password', support).expect(403);
        await login(target.phoneNumber).expect(200);
      }
    });

    it('lets nobody act on their own account', async () => {
      for (const actor of [admin, superAdmin]) {
        for (const action of ['suspend', 'block', 'reset-password', 'revoke-sessions']) {
          expect((await act(actor, action, actor).expect(403)).body.message).toMatch(/own account/);
        }
      }
      await act(support, 'reset-password', support).expect(403);
      expect((await setRoles(superAdmin, []).expect(403)).body.message).toMatch(/own account/);
      expect(await rolesOf(superAdmin.id)).toContain('SUPER_ADMIN');
    });

    it('lets only a SUPER_ADMIN change roles', async () => {
      for (const actor of [admin, support, finance, user]) {
        await setRoles(user, ['ADMIN'], actor).expect(403);
        await setRoles(actor, ['SUPER_ADMIN'], actor).expect(403);
        await setRoles(superAdmin, [], actor).expect(403);
      }
      await t.put(`/admin/users/${user.id}/roles`, { roles: ['ADMIN'], ...REASON }).expect(401);
      expect(await rolesOf(user.id)).toEqual(['USER']);
      expect(await rolesOf(superAdmin.id)).toContain('SUPER_ADMIN');
      expect(await t.prisma.auditLog.count()).toBe(0);
    });

    it('does not let a user grant themselves a role through registration or their profile', async () => {
      const res = await t.post('/auth/register', {
        phoneNumber: '+251911000099',
        password: PASSWORD,
        roles: ['SUPER_ADMIN'],
        role: 'ADMIN',
      });
      // Unknown fields are rejected outright or ignored; either way no role is granted.
      if (res.status === 201) expect(await rolesOf(res.body.userId)).toEqual(['USER']);
      else expect(res.status).toBe(400);
    });

    it('stops acting for a staff member the moment their role is removed', async () => {
      await setRoles(admin, []).expect(200);
      const fresh = await login(admin.phoneNumber).expect(200);
      await act(user, 'suspend', { ...admin, token: fresh.body.tokens.accessToken }).expect(403);
      await t.get('/admin/users', fresh.body.tokens.accessToken).expect(403);
    });

    it('keeps one SUPER_ADMIN when two demote each other at the same moment', async () => {
      const second = await account({ roles: [RoleName.SUPER_ADMIN] });
      const results = await Promise.all([setRoles(second, [], superAdmin), setRoles(superAdmin, [], second)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 403]);

      const remaining = await t.prisma.userRole.count({ where: { role: { name: RoleName.SUPER_ADMIN } } });
      expect(remaining).toBe(1);
    });

    it('lets a SUPER_ADMIN manage staff', async () => {
      await act(admin, 'suspend', superAdmin).expect(200);
      await t.get('/admin/users', admin.token).expect(401);
      expect((await login(admin.phoneNumber).expect(403)).body.error).toBe('ACCOUNT_SUSPENDED');
      await act(admin, 'reactivate', superAdmin).expect(200);
      await act(support, 'reset-password', superAdmin).expect(200);
    });
  });

  describe('roles', () => {
    it('grants a back-office role, records who granted it and signs the account out', async () => {
      const res = await setRoles(user, ['SUPPORT']).expect(200);
      expect(res.body.roles).toEqual(['USER', 'SUPPORT']);

      const grant = await t.prisma.userRole.findFirstOrThrow({
        where: { userId: user.id, role: { name: RoleName.SUPPORT } },
      });
      expect(grant.grantedById).toBe(superAdmin.id);

      await t.get('/auth/me', user.token).expect(401);
      const fresh = await login(user.phoneNumber).expect(200);
      expect(fresh.body.user.roles).toEqual(expect.arrayContaining(['USER', 'SUPPORT']));
      await t.get('/admin/users', fresh.body.tokens.accessToken).expect(200);

      const [audit] = await audits('user.roles.set');
      expect(audit).toMatchObject({
        actorId: superAdmin.id,
        entityId: user.id,
        before: { roles: ['USER'] },
        metadata: { reason: REASON.reason, granted: ['SUPPORT'], removed: [] },
      });
      expect((audit.after as { roles: string[] }).roles.sort()).toEqual(['SUPPORT', 'USER']);
    });

    it('replaces the whole set of back-office roles and can remove them all', async () => {
      await setRoles(user, ['SUPPORT', 'FINANCE']).expect(200);
      const swapped = await setRoles(user, ['FINANCE', 'ADMIN']).expect(200);
      expect(swapped.body.roles).toEqual(['USER', 'FINANCE', 'ADMIN']);

      const cleared = await setRoles(user, []).expect(200);
      expect(cleared.body.roles).toEqual(['USER']);
      const fresh = await login(user.phoneNumber).expect(200);
      await t.get('/admin/users', fresh.body.tokens.accessToken).expect(403);

      const last = (await audits('user.roles.set')).find(
        (a) => (a.metadata as { removed: string[] }).removed.length === 2,
      );
      expect(last?.metadata).toMatchObject({ granted: [], removed: ['FINANCE', 'ADMIN'] });
    });

    it('changes nothing, and writes no audit record, when the roles are already as requested', async () => {
      await setRoles(support, ['SUPPORT']).expect(200);
      expect(await audits('user.roles.set')).toHaveLength(0);
      await t.get('/auth/me', support.token).expect(200);
    });

    it('can appoint and demote another SUPER_ADMIN', async () => {
      await setRoles(admin, ['ADMIN', 'SUPER_ADMIN']).expect(200);
      expect(await rolesOf(admin.id)).toEqual(expect.arrayContaining(['ADMIN', 'SUPER_ADMIN']));
      await setRoles(admin, ['ADMIN']).expect(200);
      expect(await rolesOf(admin.id)).not.toContain('SUPER_ADMIN');
    });

    it('validates the role list', async () => {
      await setRoles(user, ['USER']).expect(400);
      await setRoles(user, ['OWNER']).expect(400);
      await setRoles(user, ['SUPPORT', 'SUPPORT']).expect(400);
      await t.put(`/admin/users/${user.id}/roles`, { roles: 'ADMIN', ...REASON }, superAdmin.token).expect(400);
      await t.put(`/admin/users/${user.id}/roles`, { roles: ['ADMIN'] }, superAdmin.token).expect(400);
      await t.put(`/admin/users/${user.id}/roles`, REASON, superAdmin.token).expect(400);
      await t.put(`/admin/users/${randomUUID()}/roles`, { roles: ['ADMIN'], ...REASON }, superAdmin.token).expect(404);
      expect(await rolesOf(user.id)).toEqual(['USER']);
    });
  });

  describe('staff password reset', () => {
    async function reset(by: Account = support): Promise<string> {
      const res = await act(user, 'reset-password', by, { reason: 'Identity confirmed by phone call' }).expect(200);
      return res.body.temporaryPassword as string;
    }

    it('returns a temporary password once and invalidates the old password and every session', async () => {
      const res = await act(user, 'reset-password', support).expect(200);
      expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{14}$/);
      expect(res.body.user).toMatchObject({ id: user.id, mustChangePassword: true, activeSessions: 0 });

      expect((await login(user.phoneNumber).expect(401)).body.error).toBe('INVALID_CREDENTIALS');
      await t.get('/auth/me', user.token).expect(401);
      await t.post('/auth/refresh', { refreshToken: user.refreshToken }).expect(401);
      await login(user.phoneNumber, res.body.temporaryPassword).expect(200);
    });

    it('gives a different password every time', async () => {
      expect(await reset()).not.toBe(await reset());
    });

    it('forces the user to choose a new password before doing anything else', async () => {
      const temporary = await reset();
      const session = await login(user.phoneNumber, temporary).expect(200);
      expect(session.body.user.mustChangePassword).toBe(true);
      const token = session.body.tokens.accessToken as string;

      for (const path of ['/wallet', '/bids/mine', '/notifications', '/winners/mine']) {
        expect((await t.get(path, token).expect(403)).body.error).toBe('PASSWORD_CHANGE_REQUIRED');
      }
      const auctionId = await activeAuction();
      const bid = await t
        .post(`/auctions/${auctionId}/bids`, { amountsMinor: ['100'] }, token)
        .set('Idempotency-Key', randomUUID())
        .expect(403);
      expect(bid.body.error).toBe('PASSWORD_CHANGE_REQUIRED');

      // Still allowed: seeing who you are, public pages, and refreshing (which does not lift the restriction).
      expect((await t.get('/auth/me', token).expect(200)).body.mustChangePassword).toBe(true);
      await t.get('/auctions', token).expect(200);
      const refreshed = await t.post('/auth/refresh', { refreshToken: session.body.tokens.refreshToken }).expect(200);
      await t.get('/wallet', refreshed.body.accessToken).expect(403);

      const changed = await t
        .post(
          '/auth/change-password',
          { currentPassword: temporary, newPassword: NEW_PASSWORD },
          refreshed.body.accessToken,
        )
        .expect(200);
      expect(changed.body.user.mustChangePassword).toBe(false);
      await t.get('/wallet', changed.body.tokens.accessToken).expect(200);

      const again = await login(user.phoneNumber, NEW_PASSWORD).expect(200);
      expect(again.body.user.mustChangePassword).toBe(false);
      await login(user.phoneNumber, temporary).expect(401);
    });

    it('does not accept the temporary password as the new password', async () => {
      const temporary = await reset();
      const session = await login(user.phoneNumber, temporary).expect(200);
      const res = await t
        .post(
          '/auth/change-password',
          { currentPassword: temporary, newPassword: temporary },
          session.body.tokens.accessToken,
        )
        .expect(400);
      expect(res.body.error).toBe('PASSWORD_REUSED');
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).mustChangePassword).toBe(true);
    });

    it('restricts a staff account too until its password is replaced', async () => {
      const res = await act(admin, 'reset-password', superAdmin).expect(200);
      const session = await login(admin.phoneNumber, res.body.temporaryPassword).expect(200);
      const blocked = await t.get('/admin/users', session.body.tokens.accessToken).expect(403);
      expect(blocked.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
      await act(user, 'suspend', { ...admin, token: session.body.tokens.accessToken }).expect(403);
    });

    it('stores and records the password nowhere in readable form', async () => {
      const temporary = await reset();
      const stored = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(stored.passwordHash).toMatch(/^\$argon2id\$/);

      const [audit] = await audits('user.password.reset');
      expect(audit).toMatchObject({
        actorId: support.id,
        actorType: 'ADMIN',
        entityId: user.id,
        after: { mustChangePassword: true },
        metadata: { reason: 'Identity confirmed by phone call' },
      });
      const events = await t.prisma.securityEvent.findMany({ where: { userId: user.id, type: 'PASSWORD_RESET' } });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toEqual({ byStaff: true, actorId: support.id });
      const notifications = await t.prisma.notification.findMany({ where: { userId: user.id } });
      expect(notifications.map((n) => n.type)).toEqual(['PASSWORD_RESET']);

      const everything = JSON.stringify([audit, events, notifications]);
      expect(everything).not.toContain(temporary);
      expect(everything).not.toContain(stored.passwordHash);
    });

    it('lifts a sign-in lockout caused by wrong passwords', async () => {
      for (let i = 0; i < 5; i++) await login(user.phoneNumber, 'Wr0ngPassword');
      expect((await login(user.phoneNumber).expect(429)).body.error).toBe('ACCOUNT_LOCKED');

      const temporary = await reset();
      await login(user.phoneNumber, temporary).expect(200);
    });

    it('is for SUPPORT and ADMIN, needs a reason and an existing user', async () => {
      await reset(admin);
      await act(user, 'reset-password', finance).expect(403);
      await act(user, 'reset-password', await account()).expect(403);
      await t.post(`/admin/users/${user.id}/reset-password`, REASON).expect(401);
      await act(user, 'reset-password', support, {}).expect(400);
      await t.post(`/admin/users/${randomUUID()}/reset-password`, REASON, support.token).expect(404);
    });

    it('works for a suspended account without reactivating it', async () => {
      await act(user, 'suspend', admin).expect(200);
      const temporary = await reset();
      expect((await login(user.phoneNumber, temporary).expect(403)).body.error).toBe('ACCOUNT_SUSPENDED');
    });
  });

  describe('revoking sessions', () => {
    it('signs the user out of every device and leaves the password alone', async () => {
      const second = await login(user.phoneNumber).expect(200);
      const res = await act(user, 'revoke-sessions', support, { reason: 'Phone reported stolen' }).expect(200);
      expect(res.body).toEqual({ revoked: 2 });

      await t.get('/auth/me', user.token).expect(401);
      await t.get('/auth/me', second.body.tokens.accessToken).expect(401);
      await t.post('/auth/refresh', { refreshToken: second.body.tokens.refreshToken }).expect(401);
      await login(user.phoneNumber).expect(200);

      const [audit] = await audits('user.sessions.revoke');
      expect(audit).toMatchObject({
        actorId: support.id,
        entityId: user.id,
        metadata: { reason: 'Phone reported stolen', revoked: 2 },
      });
    });

    it('is for SUPPORT and ADMIN', async () => {
      await act(user, 'revoke-sessions', finance).expect(403);
      await act(user, 'revoke-sessions', user).expect(403);
      await act(user, 'revoke-sessions', admin).expect(200);
    });
  });

  describe('audit log', () => {
    it('lists records newest first with the actor, and gets one by id', async () => {
      await act(user, 'suspend', admin).expect(200);
      await act(user, 'reactivate', superAdmin).expect(200);

      const res = await t.get('/admin/audit-logs', admin.token).expect(200);
      expect(res.body).toMatchObject({ total: 2, page: 1, limit: 20 });
      expect(res.body.items.map((a: { action: string }) => a.action)).toEqual(['user.reactivate', 'user.suspend']);
      expect(res.body.items[1]).toMatchObject({
        actorType: 'ADMIN',
        actor: { id: admin.id, phoneNumber: admin.phoneNumber, fullName: null },
        action: 'user.suspend',
        entityType: 'user',
        entityId: user.id,
        before: { status: 'ACTIVE' },
        after: { status: 'SUSPENDED' },
        metadata: REASON,
        createdAt: expect.any(String),
      });

      const one = await t.get(`/admin/audit-logs/${res.body.items[1].id}`, admin.token).expect(200);
      expect(one.body).toEqual(res.body.items[1]);
      await t.get(`/admin/audit-logs/${randomUUID()}`, admin.token).expect(404);
    });

    it('filters by actor, action, entity and period', async () => {
      await act(user, 'suspend', admin).expect(200);
      await act(user, 'reactivate', superAdmin).expect(200);
      await setRoles(user, ['SUPPORT']).expect(200);
      const product = await t
        .post('/admin/products', { name: 'Galaxy A55', marketValueMinor: '6500000' }, admin.token)
        .expect(201);

      const actions = async (query: string) =>
        (await t.get(`/admin/audit-logs?${query}`, admin.token).expect(200)).body.items.map(
          (a: { action: string }) => a.action,
        );
      expect(await actions(`actorId=${superAdmin.id}`)).toEqual(['user.roles.set', 'user.reactivate']);
      expect(await actions('action=user.')).toEqual(['user.roles.set', 'user.reactivate', 'user.suspend']);
      expect(await actions('action=user.suspend')).toEqual(['user.suspend']);
      expect(await actions('entityType=product')).toEqual(['product.create']);
      expect(await actions(`entityType=product&entityId=${product.body.id}`)).toEqual(['product.create']);
      expect(await actions(`entityType=user&entityId=${product.body.id}`)).toEqual([]);
      expect(await actions(`from=${encodeURIComponent(inHours(1))}`)).toEqual([]);
      expect(
        await actions(`from=${encodeURIComponent(inHours(-1))}&to=${encodeURIComponent(inHours(1))}`),
      ).toHaveLength(4);
      expect(await actions(`to=${encodeURIComponent(inHours(-1))}`)).toEqual([]);
      expect(await actions('page=2&limit=3')).toEqual(['user.suspend']);
    });

    it('validates its filters', async () => {
      await t.get('/admin/audit-logs?actorId=me', admin.token).expect(400);
      await t.get('/admin/audit-logs?from=yesterday', admin.token).expect(400);
      await t.get('/admin/audit-logs?from=2027-01-01', admin.token).expect(400);
      await t.get(`/admin/audit-logs?action=${encodeURIComponent("x' OR 1=1")}`, admin.token).expect(400);
      await t.get('/admin/audit-logs/not-a-uuid', admin.token).expect(400);
    });

    it('is ADMIN only and cannot be written through the API', async () => {
      for (const actor of [support, finance, user]) {
        await t.get('/admin/audit-logs', actor.token).expect(403);
        await t.get(`/admin/audit-logs/${randomUUID()}`, actor.token).expect(403);
        await t.get('/admin/security-events', actor.token).expect(403);
      }
      await t.get('/admin/audit-logs').expect(401);
      await t.post('/admin/audit-logs', {}, admin.token).expect(404);
    });
  });

  describe('security events', () => {
    it('lists sign-in activity and filters by type, user and phone number', async () => {
      await login(user.phoneNumber, 'Wr0ngPassword').expect(401);
      await login(user.phoneNumber).expect(200);
      await login('+251911000001', 'Wr0ngPassword').expect(401);

      const failed = await t.get('/admin/security-events?type=LOGIN_FAILED', admin.token).expect(200);
      expect(failed.body.total).toBe(2);
      expect(failed.body.items[0]).toEqual({
        id: expect.any(String),
        type: 'LOGIN_FAILED',
        userId: null,
        phoneNumber: '+251911000001',
        ipAddress: expect.any(String),
        userAgent: null,
        metadata: null,
        createdAt: expect.any(String),
      });

      const mine = await t.get(`/admin/security-events?userId=${user.id}`, admin.token).expect(200);
      expect(mine.body.items.map((e: { type: string }) => e.type)).toEqual(['LOGIN_SUCCESS', 'LOGIN_FAILED']);

      const phone = encodeURIComponent('+251911000001');
      const byPhone = await t.get(`/admin/security-events?phoneNumber=${phone}`, admin.token).expect(200);
      expect(byPhone.body.total).toBe(1);

      await t.get('/admin/security-events?type=HACKED', admin.token).expect(400);
      await t.get('/admin/security-events?phoneNumber=0911000001', admin.token).expect(400);
    });
  });

  describe('dashboard', () => {
    it('reports users, auctions, bids and money', async () => {
      const bidder = await account({ balanceMinor: 100000n });
      const other = await account({ balanceMinor: 50000n });
      const auctionId = await activeAuction();
      await draftAuction();
      const place = (by: Account, amounts: string[]) =>
        t
          .post(`/auctions/${auctionId}/bids`, { amountsMinor: amounts }, by.token)
          .set('Idempotency-Key', randomUUID())
          .expect(201);
      await place(bidder, ['100', '200', '300']);
      await place(other, ['100']);
      await act(user, 'suspend', admin).expect(200);
      await t.post(`/admin/wallets/${other.id}/freeze`, { reason: 'Under review' }, finance.token).expect(200);

      const res = await t.get('/admin/dashboard', finance.token).expect(200);
      expect(res.body).toEqual({
        generatedAt: expect.any(String),
        users: {
          total: 7,
          active: 6,
          suspended: 1,
          blocked: 0,
          staff: 4,
          newLast24h: 7,
          newLast7d: 7,
          newLast30d: 7,
        },
        auctions: { draft: 1, scheduled: 0, active: 1, closing: 0, completed: 0, cancelled: 0 },
        bids: { total: 4, last24h: 4, last7d: 4, last30d: 4 },
        winners: { pendingVerification: 0, verified: 0, rejected: 0, published: 0 },
        deliveries: { pending: 0, contacted: 0, verified: 0, dispatched: 0, delivered: 0, disputed: 0 },
        frozenWallets: 1,
        money: [
          {
            currency: 'ETB',
            minorUnits: 2,
            revenueMinor: '30000',
            revenue: '300.00',
            revenueLast24hMinor: '30000',
            revenueLast24h: '300.00',
            revenueLast7dMinor: '30000',
            revenueLast7d: '300.00',
            revenueLast30dMinor: '30000',
            revenueLast30d: '300.00',
            walletBalancesMinor: '120000',
            walletBalances: '1200.00',
            heldBalancesMinor: '0',
            heldBalances: '0.00',
          },
        ],
      });
    });

    it('takes refunds out of revenue and leaves old revenue out of the recent periods', async () => {
      const bidder = await account({ balanceMinor: 100000n });
      const auctionId = await activeAuction();
      await t
        .post(`/auctions/${auctionId}/bids`, { amountsMinor: ['100', '200'] }, bidder.token)
        .set('Idempotency-Key', randomUUID())
        .expect(201);

      // Bids, their fees and the account creation happened 10 days ago.
      await t.prisma.$executeRawUnsafe(`ALTER TABLE ledger_entries DISABLE TRIGGER USER`);
      await t.prisma.$executeRawUnsafe(`ALTER TABLE bids DISABLE TRIGGER USER`);
      try {
        await t.prisma.$executeRawUnsafe(`UPDATE ledger_entries SET created_at = now() - interval '10 days'`);
        await t.prisma.$executeRawUnsafe(`UPDATE bids SET created_at = now() - interval '10 days'`);
        await t.prisma.$executeRawUnsafe(`UPDATE users SET created_at = now() - interval '10 days'`);
      } finally {
        await t.prisma.$executeRawUnsafe(`ALTER TABLE ledger_entries ENABLE TRIGGER USER`);
        await t.prisma.$executeRawUnsafe(`ALTER TABLE bids ENABLE TRIGGER USER`);
      }
      const before = (await t.get('/admin/dashboard', admin.token).expect(200)).body;
      expect(before.users).toMatchObject({ total: 6, newLast24h: 0, newLast7d: 0, newLast30d: 6 });
      expect(before.bids).toEqual({ total: 2, last24h: 0, last7d: 0, last30d: 2 });
      expect(before.money[0]).toMatchObject({
        revenueMinor: '15000',
        revenueLast24hMinor: '0',
        revenueLast7dMinor: '0',
        revenueLast30dMinor: '15000',
        walletBalancesMinor: '85000',
      });

      await t.post(`/admin/auctions/${auctionId}/cancel`, { reason: 'Product unavailable' }, admin.token).expect(200);
      const after = (await t.get('/admin/dashboard', admin.token).expect(200)).body;
      expect(after.auctions).toMatchObject({ active: 0, cancelled: 1 });
      expect(after.money[0]).toMatchObject({
        revenueMinor: '0',
        revenue: '0.00',
        revenueLast24hMinor: '-15000',
        revenueLast24h: '-150.00',
        revenueLast30dMinor: '0',
        walletBalancesMinor: '100000',
      });
    });

    it('is for FINANCE and ADMIN', async () => {
      await t.get('/admin/dashboard', admin.token).expect(200);
      await t.get('/admin/dashboard', superAdmin.token).expect(200);
      await t.get('/admin/dashboard', support.token).expect(403);
      await t.get('/admin/dashboard', user.token).expect(403);
      await t.get('/admin/dashboard').expect(401);
    });
  });

  describe('auction statistics', () => {
    it('summarizes the bidding of one auction', async () => {
      const first = await account({ balanceMinor: 100000n });
      const second = await account({ balanceMinor: 100000n });
      const auctionId = await activeAuction();
      const place = (by: Account, amounts: string[]) =>
        t
          .post(`/auctions/${auctionId}/bids`, { amountsMinor: amounts }, by.token)
          .set('Idempotency-Key', randomUUID())
          .expect(201);

      const empty = await t.get(`/admin/auctions/${auctionId}/statistics`, support.token).expect(200);
      expect(empty.body).toMatchObject({
        bidCount: 0,
        bidderCount: 0,
        submissionCount: 0,
        distinctAmounts: 0,
        uniqueAmounts: 0,
        lowestBidMinor: null,
        highestBidMinor: null,
        feesChargedMinor: '0',
        firstBidAt: null,
        lastBidAt: null,
      });

      await place(first, ['100', '200', '500']);
      await place(first, ['300']);
      await place(second, ['100', '200']);

      const res = await t.get(`/admin/auctions/${auctionId}/statistics`, finance.token).expect(200);
      expect(res.body).toEqual({
        auctionId,
        status: 'ACTIVE',
        currency: 'ETB',
        minorUnits: 2,
        bidCount: 6,
        bidderCount: 2,
        submissionCount: 3,
        distinctAmounts: 4,
        uniqueAmounts: 2,
        lowestBidMinor: '100',
        highestBidMinor: '500',
        feesChargedMinor: '45000',
        feesCharged: '450.00',
        feesRefunded: false,
        firstBidAt: expect.any(String),
        lastBidAt: expect.any(String),
      });

      await t.post(`/admin/auctions/${auctionId}/cancel`, { reason: 'Product unavailable' }, admin.token).expect(200);
      const cancelled = await t.get(`/admin/auctions/${auctionId}/statistics`, admin.token).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', bidCount: 6, feesRefunded: true });
    });

    it('is for staff only and needs an existing auction', async () => {
      const auctionId = await activeAuction();
      await t.get(`/admin/auctions/${auctionId}/statistics`, user.token).expect(403);
      await t.get(`/admin/auctions/${auctionId}/statistics`).expect(401);
      await t.get(`/admin/auctions/${randomUUID()}/statistics`, admin.token).expect(404);
    });
  });

  async function draftAuction(): Promise<string> {
    const product = await t
      .post('/admin/products', { name: 'Galaxy A55', marketValueMinor: '6500000' }, admin.token)
      .expect(201);
    const body = {
      productId: product.body.id,
      title: 'Win a phone',
      bidFeeMinor: '7500',
      minBidMinor: '100',
      maxBidMinor: '100000',
      bidStepMinor: '100',
      opensAt: inHours(1),
      closesAt: inHours(25),
      noUniqueBidPolicy: 'NO_WINNER',
    };
    return (await t.post('/admin/auctions', body, admin.token).expect(201)).body.id as string;
  }

  async function activeAuction(): Promise<string> {
    const id = await draftAuction();
    await t.post(`/admin/auctions/${id}/activate`, {}, admin.token).expect(200);
    return id;
  }
});
