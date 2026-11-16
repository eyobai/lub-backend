import { RoleName, WalletTransactionType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { ReconciliationService } from '../src/modules/ledger/reconciliation.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';

interface Account {
  id: string;
  token: string;
}

describe('Wallet and ledger', () => {
  let t: TestApp;
  let wallets: WalletService;
  let ledger: LedgerService;
  let reconciliation: ReconciliationService;
  let phoneCounter = 0;

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
    wallets = t.app.get(WalletService);
    ledger = t.app.get(LedgerService);
    reconciliation = t.app.get(ReconciliationService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  /** Registers a user through the API; staff roles are granted directly, as the seed script does. */
  async function account(...roles: RoleName[]): Promise<Account> {
    const phoneNumber = `+2519${String(10000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    for (const name of roles) {
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: role.id } });
    }
    return { id: res.body.userId, token: res.body.tokens.accessToken };
  }

  const adjust = (
    staff: Account,
    userId: string,
    direction: 'CREDIT' | 'DEBIT',
    amountMinor: string,
    key: string = randomUUID(),
    reason = 'Correction for support ticket 1001',
  ) =>
    t
      .post(`/admin/wallets/${userId}/adjustments`, { direction, amountMinor, reason }, staff.token)
      .set('Idempotency-Key', key);

  const balance = async (user: Account): Promise<string> =>
    (await t.get('/wallet', user.token).expect(200)).body.availableMinor;

  async function expectBooksToBalance(): Promise<void> {
    const report = await reconciliation.reconcile();
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  }

  describe('GET /wallet', () => {
    it('requires authentication', async () => {
      const res = await t.get('/wallet');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('creates an empty ETB wallet on first use and returns the same one afterwards', async () => {
      const user = await account();

      const first = await t.get('/wallet', user.token).expect(200);
      expect(first.body).toMatchObject({
        userId: user.id,
        currency: 'ETB',
        minorUnits: 2,
        availableMinor: '0',
        available: '0.00',
        heldMinor: '0',
        held: '0.00',
        isFrozen: false,
      });
      const second = await t.get('/wallet', user.token).expect(200);
      expect(second.body.id).toBe(first.body.id);
    });

    it('creates exactly one wallet when first requests arrive concurrently', async () => {
      const user = await account();

      const results = await Promise.all(Array.from({ length: 10 }, () => t.get('/wallet', user.token)));

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await t.prisma.wallet.count({ where: { userId: user.id } })).toBe(1);
      // Spendable, held for withdrawals, and top-up bonus.
      expect(await t.prisma.ledgerAccount.count({ where: { wallet: { userId: user.id } } })).toBe(3);
    });

    it('rejects unknown currencies', async () => {
      const user = await account();
      const res = await t.get('/wallet?currency=USD', user.token);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('CURRENCY_NOT_SUPPORTED');
      expect((await t.get('/wallet?currency=birr', user.token)).body.error).toBe('VALIDATION_FAILED');
    });
  });

  describe('ledger postings', () => {
    it('records a deposit as a balanced journal and updates the balance', async () => {
      const user = await account();

      const { transaction } = await wallets.deposit({ userId: user.id, amountMinor: 12345n, description: 'Top-up' });

      expect(transaction).toMatchObject({ type: 'DEPOSIT', status: 'POSTED', currency: 'ETB', amountMinor: 12345n });
      expect(transaction.reference).toMatch(/^TX-\d{8}-[0-9A-Z]{10}$/);
      expect(transaction.entries).toHaveLength(2);
      const debit = transaction.entries.find((e) => e.direction === 'DEBIT')!;
      const credit = transaction.entries.find((e) => e.direction === 'CREDIT')!;
      expect(debit.amountMinor).toBe(12345n);
      expect(credit.amountMinor).toBe(12345n);
      expect(credit.balanceAfterMinor).toBe(12345n);

      const wallet = await t.get('/wallet', user.token).expect(200);
      expect(wallet.body).toMatchObject({ availableMinor: '12345', available: '123.45' });
      const clearing = await t.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'PAYMENT_CLEARING:ETB' } });
      expect(clearing.balanceMinor).toBe(12345n);
      await expectBooksToBalance();
    });

    it('charges bid fees to platform revenue and refunds them back', async () => {
      const user = await account();
      await wallets.deposit({ userId: user.id, amountMinor: 10000n });

      await wallets.chargeBidFee({ userId: user.id, amountMinor: 1500n });
      await wallets.chargeBidFee({ userId: user.id, amountMinor: 1500n });
      expect(await balance(user)).toBe('7000');
      const revenue = () => t.prisma.ledgerAccount.findUniqueOrThrow({ where: { code: 'PLATFORM_REVENUE:ETB' } });
      expect((await revenue()).balanceMinor).toBe(3000n);

      await wallets.refund({ userId: user.id, amountMinor: 1500n });
      expect(await balance(user)).toBe('8500');
      expect((await revenue()).balanceMinor).toBe(1500n);
      await expectBooksToBalance();
    });

    it('refuses to overdraw a wallet and moves no money', async () => {
      const user = await account();
      await wallets.deposit({ userId: user.id, amountMinor: 1000n });

      await expect(wallets.chargeBidFee({ userId: user.id, amountMinor: 1001n })).rejects.toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
        details: { currency: 'ETB', requiredMinor: '1001', availableMinor: '1000' },
      });

      expect(await balance(user)).toBe('1000');
      expect(await t.prisma.walletTransaction.count()).toBe(1);
      expect(await t.prisma.ledgerEntry.count()).toBe(2);
      await wallets.chargeBidFee({ userId: user.id, amountMinor: 1000n });
      expect(await balance(user)).toBe('0');
    });

    it('rolls the money back when the surrounding unit of work fails', async () => {
      const user = await account();
      await wallets.deposit({ userId: user.id, amountMinor: 5000n });

      // What a failed bid looks like: the fee is charged, then a later step in the same transaction throws.
      await expect(
        ledger.run(async (tx) => {
          await wallets.chargeBidFee({ userId: user.id, amountMinor: 2000n }, tx);
          throw new Error('bid could not be stored');
        }),
      ).rejects.toThrow('bid could not be stored');

      expect(await balance(user)).toBe('5000');
      expect(await t.prisma.walletTransaction.count({ where: { type: 'BID_FEE' } })).toBe(0);
      await expectBooksToBalance();
    });

    it('applies an idempotency key once, even under concurrent retries', async () => {
      const user = await account();
      const movement = { userId: user.id, amountMinor: 4000n, idempotencyKey: 'payment:test:abc-123' };

      const results = await Promise.all(Array.from({ length: 8 }, () => wallets.deposit(movement)));

      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
      expect(await balance(user)).toBe('4000');
      expect(await t.prisma.walletTransaction.count()).toBe(1);

      const later = await wallets.deposit(movement);
      expect(later.replayed).toBe(true);
      expect(await balance(user)).toBe('4000');
    });

    it('rejects an idempotency key reused for a different movement', async () => {
      const user = await account();
      await wallets.deposit({ userId: user.id, amountMinor: 4000n, idempotencyKey: 'payment:test:xyz' });

      await expect(
        wallets.deposit({ userId: user.id, amountMinor: 9000n, idempotencyKey: 'payment:test:xyz' }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await balance(user)).toBe('4000');
    });

    it('never overdraws under concurrent spending', async () => {
      const user = await account();
      await wallets.deposit({ userId: user.id, amountMinor: 1000n });

      // 30 simultaneous fees of 100 against a balance of 1000: exactly 10 may succeed.
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, () => wallets.chargeBidFee({ userId: user.id, amountMinor: 100n })),
      );

      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
      expect(failures).toHaveLength(20);
      expect(failures.every((f) => (f.reason as { code?: string }).code === 'INSUFFICIENT_FUNDS')).toBe(true);
      expect(await balance(user)).toBe('0');
      await expectBooksToBalance();
    });

    it('keeps every balance exact under concurrent mixed activity across wallets', async () => {
      const users = await Promise.all([account(), account(), account()]);
      await Promise.all(users.map((u) => wallets.deposit({ userId: u.id, amountMinor: 100000n })));

      await Promise.all(
        users.flatMap((u) => [
          ...Array.from({ length: 10 }, () => wallets.deposit({ userId: u.id, amountMinor: 700n })),
          ...Array.from({ length: 10 }, () => wallets.chargeBidFee({ userId: u.id, amountMinor: 300n })),
          ...Array.from({ length: 5 }, () => wallets.refund({ userId: u.id, amountMinor: 100n })),
        ]),
      );

      for (const u of users) expect(await balance(u)).toBe(String(100000 + 7000 - 3000 + 500));

      // The running balance stored on each line must follow from the line before it.
      const wallet = await t.prisma.wallet.findFirstOrThrow({ where: { userId: users[0].id } });
      const lines = await t.prisma.ledgerEntry.findMany({
        where: { account: { walletId: wallet.id, type: 'USER_WALLET' } },
        orderBy: { sequence: 'asc' },
      });
      let running = 0n;
      for (const line of lines) {
        running += line.direction === 'CREDIT' ? line.amountMinor : -line.amountMinor;
        expect(line.balanceAfterMinor).toBe(running);
      }
      expect(lines).toHaveLength(26);
      await expectBooksToBalance();
    });
  });

  describe('database protections', () => {
    it('does not allow ledger lines to be edited or deleted', async () => {
      const user = await account();
      const { transaction } = await wallets.deposit({ userId: user.id, amountMinor: 5000n });
      const entryId = transaction.entries[0].id;

      await expect(
        t.prisma.$executeRaw`UPDATE ledger_entries SET amount_minor = 1 WHERE id = ${entryId}::uuid`,
      ).rejects.toThrow(/not allowed|immutable/i);
      await expect(t.prisma.$executeRaw`DELETE FROM ledger_entries WHERE id = ${entryId}::uuid`).rejects.toThrow(
        /not allowed|immutable/i,
      );
      expect(await t.prisma.ledgerEntry.count()).toBe(2);
    });

    it('does not allow journals to be deleted or rewritten', async () => {
      const user = await account();
      const { transaction } = await wallets.deposit({ userId: user.id, amountMinor: 5000n });

      await expect(
        t.prisma.$executeRaw`UPDATE wallet_transactions SET amount_minor = 1 WHERE id = ${transaction.id}::uuid`,
      ).rejects.toThrow(/immutable/i);
      await expect(
        t.prisma.$executeRaw`DELETE FROM wallet_transactions WHERE id = ${transaction.id}::uuid`,
      ).rejects.toThrow(/not allowed/i);
    });

    it('rejects an unbalanced journal at commit', async () => {
      const user = await account();
      const { available } = await wallets.ensureWallet(user.id, 'ETB');

      await expect(
        t.prisma.$transaction(async (tx) => {
          const journal = await tx.walletTransaction.create({
            data: { reference: 'TX-TEST-UNBALANCED', type: 'DEPOSIT', currency: 'ETB', amountMinor: 500n },
          });
          await tx.ledgerEntry.create({
            data: {
              transactionId: journal.id,
              accountId: available.id,
              direction: 'CREDIT',
              amountMinor: 500n,
              balanceAfterMinor: 500n,
            },
          });
        }),
      ).rejects.toThrow(/Unbalanced ledger transaction/);
      expect(await t.prisma.walletTransaction.count()).toBe(0);
    });

    it('rejects a negative wallet balance even when written directly', async () => {
      const user = await account();
      const { available } = await wallets.ensureWallet(user.id, 'ETB');

      await expect(
        t.prisma.$executeRaw`UPDATE ledger_accounts SET balance_minor = -1 WHERE id = ${available.id}::uuid`,
      ).rejects.toThrow(/ledger_accounts_non_negative_chk/);
    });

    it('reports a cached balance that no longer matches the ledger', async () => {
      const user = await account();
      await wallets.deposit({ userId: user.id, amountMinor: 5000n });
      const { available } = await wallets.ensureWallet(user.id, 'ETB');
      await t.prisma.$executeRaw`UPDATE ledger_accounts SET balance_minor = 9999 WHERE id = ${available.id}::uuid`;

      const report = await reconciliation.reconcile();

      expect(report.ok).toBe(false);
      expect(report.issues.map((i) => i.kind).sort()).toEqual([
        'BALANCE_MISMATCH',
        'RUNNING_BALANCE_MISMATCH',
        'TRIAL_BALANCE_NOT_ZERO',
      ]);
      expect(report.issues.find((i) => i.kind === 'BALANCE_MISMATCH')).toMatchObject({ subject: available.code });
    });
  });

  describe('transaction history', () => {
    it('lists my transactions newest first with running balances, paging and type filter', async () => {
      const user = await account();
      await wallets.deposit({ userId: user.id, amountMinor: 10000n, description: 'Top-up' });
      await wallets.chargeBidFee({ userId: user.id, amountMinor: 1500n, description: 'Bid fee' });
      await wallets.chargeBidFee({ userId: user.id, amountMinor: 1500n, description: 'Bid fee' });
      await wallets.refund({ userId: user.id, amountMinor: 1500n, description: 'Refund' });

      const all = await t.get('/wallet/transactions', user.token).expect(200);
      expect(all.body.nextCursor).toBeNull();
      expect(
        all.body.items.map((i: Record<string, string>) => [i.type, i.direction, i.amountMinor, i.balanceAfterMinor]),
      ).toEqual([
        ['REFUND', 'CREDIT', '1500', '8500'],
        ['BID_FEE', 'DEBIT', '1500', '7000'],
        ['BID_FEE', 'DEBIT', '1500', '8500'],
        ['DEPOSIT', 'CREDIT', '10000', '10000'],
      ]);
      expect(all.body.items[0]).toMatchObject({
        status: 'POSTED',
        currency: 'ETB',
        amount: '15.00',
        balanceAfter: '85.00',
        description: 'Refund',
        reversalOf: null,
      });

      const page1 = await t.get('/wallet/transactions?limit=3', user.token).expect(200);
      expect(page1.body.items).toHaveLength(3);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      const page2 = await t.get(`/wallet/transactions?limit=3&cursor=${page1.body.nextCursor}`, user.token).expect(200);
      expect(page2.body.items.map((i: { type: string }) => i.type)).toEqual(['DEPOSIT']);
      expect(page2.body.nextCursor).toBeNull();

      const fees = await t.get('/wallet/transactions?type=BID_FEE', user.token).expect(200);
      expect(fees.body.items).toHaveLength(2);

      expect((await t.get('/wallet/transactions?limit=0', user.token)).status).toBe(400);
      expect((await t.get('/wallet/transactions?limit=101', user.token)).status).toBe(400);
      expect((await t.get('/wallet/transactions?cursor=abc', user.token)).status).toBe(400);
      expect((await t.get('/wallet/transactions?type=NOPE', user.token)).status).toBe(400);
    });

    it("never shows another user's transactions", async () => {
      const [alice, bob] = await Promise.all([account(), account()]);
      const { transaction } = await wallets.deposit({ userId: alice.id, amountMinor: 10000n });

      await t.get(`/wallet/transactions/${transaction.id}`, alice.token).expect(200);
      const res = await t.get(`/wallet/transactions/${transaction.id}`, bob.token);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
      expect((await t.get('/wallet/transactions', bob.token).expect(200)).body.items).toEqual([]);
      expect((await t.get('/wallet/transactions/not-a-uuid', alice.token)).status).toBe(400);
    });
  });

  describe('admin: authorization', () => {
    it('rejects anonymous callers and ordinary users on every admin wallet route', async () => {
      const user = await account();
      const target = await account();
      const body = { direction: 'CREDIT', amountMinor: '5000', reason: 'Trying my luck here' };
      const routes: [string, 'get' | 'post', string][] = [
        ['get', 'get', `/admin/wallets/${target.id}`],
        ['get', 'get', `/admin/wallets/${target.id}/transactions`],
        ['post', 'post', `/admin/wallets/${target.id}/adjustments`],
        ['post', 'post', `/admin/wallets/${target.id}/freeze`],
        ['post', 'post', `/admin/wallets/${target.id}/unfreeze`],
        ['post', 'post', `/admin/wallet-transactions/${randomUUID()}/reverse`],
        ['get', 'get', '/admin/ledger/reconciliation'],
      ];

      for (const [, method, path] of routes) {
        const call = (token?: string) =>
          method === 'get' ? t.get(path, token) : t.post(path, body, token).set('Idempotency-Key', randomUUID());
        expect((await call()).status).toBe(401);
        const res = await call(user.token);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('FORBIDDEN');
      }
      expect(await t.prisma.walletTransaction.count()).toBe(0);
      expect(await t.prisma.auditLog.count()).toBe(0);
    });

    it('lets SUPPORT and ADMIN read wallets but not move money or freeze', async () => {
      const target = await account();
      for (const role of [RoleName.SUPPORT, RoleName.ADMIN]) {
        const staff = await account(role);
        await t.get(`/admin/wallets/${target.id}`, staff.token).expect(200);
        await t.get(`/admin/wallets/${target.id}/transactions`, staff.token).expect(200);
        expect((await adjust(staff, target.id, 'CREDIT', '5000')).status).toBe(403);
        expect((await t.post(`/admin/wallets/${target.id}/freeze`, { reason: 'Suspicious' }, staff.token)).status).toBe(
          403,
        );
        expect((await t.get('/admin/ledger/reconciliation', staff.token)).status).toBe(403);
      }
      expect(await balance(target)).toBe('0');
    });

    it('lets SUPER_ADMIN do everything FINANCE can', async () => {
      const root = await account(RoleName.SUPER_ADMIN);
      const target = await account();
      await adjust(root, target.id, 'CREDIT', '5000').expect(201);
      await t.get('/admin/ledger/reconciliation', root.token).expect(200);
    });

    it('stops staff from adjusting their own wallet', async () => {
      const finance = await account(RoleName.FINANCE);
      const res = await adjust(finance, finance.id, 'CREDIT', '5000');
      expect(res.status).toBe(403);
      expect(await balance(finance)).toBe('0');
    });
  });

  describe('admin: adjustments', () => {
    let finance: Account;
    let user: Account;
    beforeEach(async () => {
      finance = await account(RoleName.FINANCE);
      user = await account();
    });

    it('credits and debits a wallet, and writes an audit record for each', async () => {
      const credit = await adjust(finance, user.id, 'CREDIT', '5000').expect(201);
      expect(credit.body).toMatchObject({
        type: 'ADJUSTMENT',
        status: 'POSTED',
        direction: 'CREDIT',
        amountMinor: '5000',
        amount: '50.00',
        balanceAfterMinor: '5000',
        description: 'Correction for support ticket 1001',
      });
      const debit = await adjust(finance, user.id, 'DEBIT', '1200').expect(201);
      expect(debit.body).toMatchObject({ direction: 'DEBIT', balanceAfterMinor: '3800' });
      expect(await balance(user)).toBe('3800');

      const audits = await t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({
        actorId: finance.id,
        actorType: 'ADMIN',
        action: 'wallet.adjust',
        entityType: 'wallet',
        before: { availableMinor: '0' },
        after: { availableMinor: '5000' },
        metadata: {
          userId: user.id,
          transactionId: credit.body.id,
          direction: 'CREDIT',
          amountMinor: '5000',
          currency: 'ETB',
          reason: 'Correction for support ticket 1001',
        },
      });
      expect(audits[0].requestId).toEqual(expect.any(String));
      expect(audits[1]).toMatchObject({ before: { availableMinor: '5000' }, after: { availableMinor: '3800' } });

      const journal = await t.prisma.walletTransaction.findUniqueOrThrow({ where: { id: credit.body.id } });
      expect(journal.createdById).toBe(finance.id);
      const seen = await t.get(`/admin/wallets/${user.id}/transactions`, finance.token).expect(200);
      expect(seen.body.items).toHaveLength(2);
      await expectBooksToBalance();
    });

    it('applies a retried request once', async () => {
      const key = randomUUID();
      const first = await adjust(finance, user.id, 'CREDIT', '5000', key).expect(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();

      const retry = await adjust(finance, user.id, 'CREDIT', '5000', key).expect(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.id).toBe(first.body.id);

      const burst = await Promise.all(Array.from({ length: 5 }, () => adjust(finance, user.id, 'CREDIT', '5000', key)));
      expect(burst.every((r) => r.status === 201 && r.body.id === first.body.id)).toBe(true);

      expect(await balance(user)).toBe('5000');
      expect(await t.prisma.auditLog.count()).toBe(1);
    });

    it('rejects a key reused for a different adjustment', async () => {
      const key = randomUUID();
      await adjust(finance, user.id, 'CREDIT', '5000', key).expect(201);

      const res = await adjust(finance, user.id, 'CREDIT', '9000', key);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balance(user)).toBe('5000');
    });

    it('scopes keys to the staff member who sent them', async () => {
      const otherFinance = await account(RoleName.FINANCE);
      const key = randomUUID();
      await adjust(finance, user.id, 'CREDIT', '5000', key).expect(201);
      await adjust(otherFinance, user.id, 'CREDIT', '5000', key).expect(201);
      expect(await balance(user)).toBe('10000');
    });

    it('requires a well-formed Idempotency-Key header', async () => {
      const body = { direction: 'CREDIT', amountMinor: '5000', reason: 'No key supplied here' };
      const missing = await t.post(`/admin/wallets/${user.id}/adjustments`, body, finance.token);
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await adjust(finance, user.id, 'CREDIT', '5000', 'short')).body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(await balance(user)).toBe('0');
    });

    it('cannot debit more than the wallet holds', async () => {
      await adjust(finance, user.id, 'CREDIT', '5000').expect(201);

      const res = await adjust(finance, user.id, 'DEBIT', '5001');
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INSUFFICIENT_FUNDS');
      expect(res.body.details).toEqual({ currency: 'ETB', requiredMinor: '5001', availableMinor: '5000' });
      expect(await balance(user)).toBe('5000');
      expect(await t.prisma.auditLog.count()).toBe(1);
    });

    it.each([
      ['a decimal amount', { amountMinor: '50.5' }],
      ['a numeric (non-string) amount', { amountMinor: 5000 }],
      ['a zero amount', { amountMinor: '0' }],
      ['a negative amount', { amountMinor: '-5000' }],
      ['an oversized amount', { amountMinor: '1'.padEnd(17, '0') }],
      ['an unknown direction', { direction: 'SIDEWAYS' }],
      ['a missing reason', { reason: undefined }],
      ['a too-short reason', { reason: 'oops' }],
      ['unknown fields', { balanceMinor: '999999' }],
    ])('rejects %s', async (_name, override) => {
      const body = { direction: 'CREDIT', amountMinor: '5000', reason: 'Valid reason text', ...override };
      const res = await t
        .post(`/admin/wallets/${user.id}/adjustments`, body, finance.token)
        .set('Idempotency-Key', randomUUID());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_FAILED');
      expect(await t.prisma.walletTransaction.count()).toBe(0);
    });

    it('returns 404 for unknown users and 400 for unsupported currencies', async () => {
      expect((await adjust(finance, randomUUID(), 'CREDIT', '5000')).status).toBe(404);
      expect((await t.get(`/admin/wallets/${randomUUID()}`, finance.token)).status).toBe(404);
      const res = await t
        .post(
          `/admin/wallets/${user.id}/adjustments`,
          { direction: 'CREDIT', amountMinor: '5000', currency: 'USD', reason: 'Wrong currency' },
          finance.token,
        )
        .set('Idempotency-Key', randomUUID());
      expect(res.body.error).toBe('CURRENCY_NOT_SUPPORTED');
    });
  });

  describe('admin: reversals', () => {
    let finance: Account;
    let user: Account;
    beforeEach(async () => {
      finance = await account(RoleName.FINANCE);
      user = await account();
    });

    const reverse = (id: string, key: string = randomUUID(), staff: Account = finance) =>
      t
        .post(`/admin/wallet-transactions/${id}/reverse`, { reason: 'Entered against the wrong customer' }, staff.token)
        .set('Idempotency-Key', key);

    it('reverses an adjustment with a mirror journal and keeps the original lines', async () => {
      const original = await adjust(finance, user.id, 'CREDIT', '5000').expect(201);

      const reversal = await reverse(original.body.id).expect(201);

      expect(reversal.body).toMatchObject({
        type: 'ADJUSTMENT',
        direction: 'DEBIT',
        amountMinor: '5000',
        balanceAfterMinor: '0',
        reversalOf: original.body.reference,
      });
      expect(reversal.body.id).not.toBe(original.body.id);
      expect(await balance(user)).toBe('0');

      const history = await t.get('/wallet/transactions', user.token).expect(200);
      expect(history.body.items.map((i: { status: string }) => i.status)).toEqual(['POSTED', 'REVERSED']);
      expect(await t.prisma.ledgerEntry.count()).toBe(4);
      expect(await t.prisma.auditLog.count({ where: { action: 'wallet.adjustment.reverse' } })).toBe(1);
      await expectBooksToBalance();
    });

    it('reverses a transaction only once, even under concurrent requests', async () => {
      const original = await adjust(finance, user.id, 'CREDIT', '5000').expect(201);
      await adjust(finance, user.id, 'CREDIT', '20000').expect(201);

      const results = await Promise.all(Array.from({ length: 6 }, () => reverse(original.body.id)));

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const rejected = results.filter((r) => r.status !== 201);
      expect(rejected).toHaveLength(5);
      expect(rejected.every((r) => r.status === 409 && r.body.error === 'TRANSACTION_ALREADY_REVERSED')).toBe(true);
      expect(await balance(user)).toBe('20000');
    });

    it('treats a retried reversal as the same operation', async () => {
      const original = await adjust(finance, user.id, 'CREDIT', '5000').expect(201);
      const key = randomUUID();

      const first = await reverse(original.body.id, key).expect(201);
      const retry = await reverse(original.body.id, key).expect(201);

      expect(retry.body.id).toBe(first.body.id);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(await balance(user)).toBe('0');
    });

    it('will not reverse a reversal, a non-adjustment, or an unknown transaction', async () => {
      const original = await adjust(finance, user.id, 'CREDIT', '5000').expect(201);
      const reversal = await reverse(original.body.id).expect(201);
      const again = await reverse(reversal.body.id);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('TRANSACTION_NOT_REVERSIBLE');

      const deposit = await wallets.deposit({ userId: user.id, amountMinor: 3000n });
      const res = await reverse(deposit.transaction.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('TRANSACTION_NOT_REVERSIBLE');

      expect((await reverse(randomUUID())).status).toBe(404);
      expect(await balance(user)).toBe('3000');
    });

    it('will not reverse a credit that has already been spent', async () => {
      const original = await adjust(finance, user.id, 'CREDIT', '5000').expect(201);
      await wallets.chargeBidFee({ userId: user.id, amountMinor: 4000n });

      const res = await reverse(original.body.id);

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INSUFFICIENT_FUNDS');
      expect(await balance(user)).toBe('1000');
      const journal = await t.prisma.walletTransaction.findUniqueOrThrow({ where: { id: original.body.id } });
      expect(journal.status).toBe('POSTED');
    });
  });

  describe('admin: freezing', () => {
    it('blocks spending from a frozen wallet but still accepts incoming money, and audits the change', async () => {
      const finance = await account(RoleName.FINANCE);
      const user = await account();
      await wallets.deposit({ userId: user.id, amountMinor: 5000n });

      const frozen = await t
        .post(`/admin/wallets/${user.id}/freeze`, { reason: 'Chargeback investigation' }, finance.token)
        .expect(200);
      expect(frozen.body.isFrozen).toBe(true);
      await t
        .post(`/admin/wallets/${user.id}/freeze`, { reason: 'Chargeback investigation' }, finance.token)
        .expect(200);

      await expect(wallets.chargeBidFee({ userId: user.id, amountMinor: 100n })).rejects.toMatchObject({
        code: 'WALLET_FROZEN',
      });
      await wallets.deposit({ userId: user.id, amountMinor: 700n });
      expect(await balance(user)).toBe('5700');
      expect((await t.get('/wallet', user.token)).body.isFrozen).toBe(true);

      await t.post(`/admin/wallets/${user.id}/unfreeze`, { reason: 'Investigation closed' }, finance.token).expect(200);
      await wallets.chargeBidFee({ userId: user.id, amountMinor: 100n });
      expect(await balance(user)).toBe('5600');

      const audits = await t.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      expect(audits.map((a) => a.action)).toEqual(['wallet.freeze', 'wallet.unfreeze']);
      expect(audits[0]).toMatchObject({ actorId: finance.id, metadata: { userId: user.id } });
    });
  });

  describe('admin: reconciliation', () => {
    it('reports balanced books with totals per account type', async () => {
      const finance = await account(RoleName.FINANCE);
      const [a, b] = await Promise.all([account(), account()]);
      await wallets.deposit({ userId: a.id, amountMinor: 10000n });
      await wallets.deposit({ userId: b.id, amountMinor: 4000n });
      await wallets.chargeBidFee({ userId: a.id, amountMinor: 2500n });
      await adjust(finance, b.id, 'CREDIT', '600').expect(201);

      const res = await t.get('/admin/ledger/reconciliation', finance.token).expect(200);

      expect(res.body).toMatchObject({ ok: true, issues: [], transactions: 4, entries: 8 });
      const total = (type: string) =>
        res.body.totals.find((x: { accountType: string }) => x.accountType === type).balanceMinor;
      expect(total('USER_WALLET')).toBe('12100');
      expect(total('PLATFORM_REVENUE')).toBe('2500');
      expect(total('PAYMENT_CLEARING')).toBe('14000');
      expect(total('ADJUSTMENTS')).toBe('-600');
      expect(Object.values(WalletTransactionType)).toContain('ADJUSTMENT');
    });
  });
});
