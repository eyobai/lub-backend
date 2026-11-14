import { RoleName } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuctionLifecycleProcessor } from '../src/modules/auctions/auction-lifecycle.processor';
import { AuctionLifecycleService } from '../src/modules/auctions/auction-lifecycle.service';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd';
const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

interface Account {
  id: string;
  token: string;
}

describe('Products and auctions', () => {
  let t: TestApp;
  let lifecycle: AuctionLifecycleService;
  let admin: Account;
  let phoneCounter = 0;

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
    lifecycle = t.app.get(AuctionLifecycleService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await account(RoleName.ADMIN);
  });

  async function account(...roles: RoleName[]): Promise<Account> {
    const phoneNumber = `+2519${String(20000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    for (const name of roles) {
      const role = await t.prisma.role.findUniqueOrThrow({ where: { name } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: role.id } });
    }
    return { id: res.body.userId, token: res.body.tokens.accessToken };
  }

  const productBody = (override: object = {}) => ({
    name: 'Samsung Galaxy A55',
    description: 'Brand new, sealed',
    brand: 'Samsung',
    model: 'SM-A556E',
    marketValueMinor: '6500000',
    specifications: { Storage: '256 GB', 'Screen size (in)': 6.6, '5G': true },
    images: [
      { url: 'https://cdn.example.com/a55-front.jpg', altText: 'Front' },
      { url: 'https://cdn.example.com/a55-back.jpg' },
    ],
    ...override,
  });
  const createProduct = async (override: object = {}): Promise<string> =>
    (await t.post('/admin/products', productBody(override), admin.token).expect(201)).body.id;

  const auctionBody = (productId: string, override: object = {}) => ({
    productId,
    title: 'Win a Galaxy A55',
    bidFeeMinor: '7500',
    minBidMinor: '100',
    maxBidMinor: '100000',
    bidStepMinor: '100',
    opensAt: inHours(1),
    closesAt: inHours(25),
    noUniqueBidPolicy: 'NO_WINNER',
    ...override,
  });
  const createAuction = async (override: object = {}, productId?: string): Promise<string> => {
    const body = auctionBody(productId ?? (await createProduct()), override);
    return (await t.post('/admin/auctions', body, admin.token).expect(201)).body.id;
  };
  const act = (id: string, action: string, body: object = {}, token = admin.token) =>
    t.post(`/admin/auctions/${id}/${action}`, body, token);
  const status = async (id: string): Promise<string> =>
    (await t.prisma.auction.findUniqueOrThrow({ where: { id } })).status;
  /** Moves an auction's window into the past, as if time had gone by. */
  const shiftWindow = (id: string, opensInHours: number, closesInHours: number) =>
    t.prisma.auction.update({
      where: { id },
      data: {
        opensAt: new Date(Date.now() + opensInHours * HOUR),
        closesAt: new Date(Date.now() + closesInHours * HOUR),
      },
    });

  describe('products', () => {
    it('creates a product with images and specifications, and audits it', async () => {
      const res = await t.post('/admin/products', productBody(), admin.token).expect(201);

      expect(res.body).toMatchObject({
        name: 'Samsung Galaxy A55',
        brand: 'Samsung',
        model: 'SM-A556E',
        currency: 'ETB',
        marketValueMinor: '6500000',
        marketValue: '65000.00',
        specifications: { Storage: '256 GB', 'Screen size (in)': 6.6, '5G': true },
        status: 'AVAILABLE',
        createdById: admin.id,
      });
      expect(
        res.body.images.map((i: { url: string; altText: string | null; sortOrder: number }) => [
          i.url,
          i.altText,
          i.sortOrder,
        ]),
      ).toEqual([
        ['https://cdn.example.com/a55-front.jpg', 'Front', 0],
        ['https://cdn.example.com/a55-back.jpg', null, 1],
      ]);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'product.create' } });
      expect(audit).toMatchObject({ actorId: admin.id, entityType: 'product', entityId: res.body.id });
      expect((await t.get(`/admin/products/${res.body.id}`, admin.token).expect(200)).body.id).toBe(res.body.id);
    });

    it.each([
      ['a missing name', { name: undefined }],
      ['a decimal market value', { marketValueMinor: '650.50' }],
      ['a numeric market value', { marketValueMinor: 6500000 }],
      ['a negative market value', { marketValueMinor: '-1' }],
      ['an image that is not a URL', { images: [{ url: 'javascript:alert(1)' }] }],
      [
        'too many images',
        { images: Array.from({ length: 11 }, (_, i) => ({ url: `https://cdn.example.com/${i}.jpg` })) },
      ],
      ['nested specifications', { specifications: { size: { width: 1 } } }],
      ['an unknown status', { status: 'SOLD' }],
      ['unknown fields', { id: randomUUID() }],
    ])('rejects %s', async (_name, override) => {
      const res = await t.post('/admin/products', productBody(override), admin.token);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_FAILED');
      expect(await t.prisma.product.count()).toBe(0);
    });

    it('rejects an unsupported currency', async () => {
      const res = await t.post('/admin/products', productBody({ currency: 'USD' }), admin.token);
      expect(res.body.error).toBe('CURRENCY_NOT_SUPPORTED');
    });

    it('updates only the fields sent, replaces images, clears with null and audits before/after', async () => {
      const id = await createProduct();

      const res = await t
        .patch(
          `/admin/products/${id}`,
          {
            name: 'Galaxy A55 5G',
            brand: null,
            marketValueMinor: '7000000',
            images: [{ url: 'https://cdn.example.com/new.jpg' }],
          },
          admin.token,
        )
        .expect(200);

      expect(res.body).toMatchObject({
        name: 'Galaxy A55 5G',
        brand: null,
        model: 'SM-A556E',
        marketValue: '70000.00',
      });
      expect(res.body.images.map((i: { url: string }) => i.url)).toEqual(['https://cdn.example.com/new.jpg']);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'product.update' } });
      expect(audit.before).toMatchObject({ name: 'Samsung Galaxy A55', brand: 'Samsung', marketValueMinor: '6500000' });
      expect(audit.after).toMatchObject({ name: 'Galaxy A55 5G', brand: null, marketValueMinor: '7000000' });

      expect((await t.patch(`/admin/products/${id}`, {}, admin.token)).status).toBe(400);
      expect((await t.patch(`/admin/products/${id}`, { name: null }, admin.token)).status).toBe(400);
      expect((await t.patch(`/admin/products/${id}`, { currency: 'ETB' }, admin.token)).status).toBe(400);
      expect((await t.patch(`/admin/products/${randomUUID()}`, { name: 'Nothing' }, admin.token)).status).toBe(404);
    });

    it('lists with paging, status filter and search', async () => {
      await createProduct({ name: 'iPhone 15', brand: 'Apple' });
      await createProduct({ name: 'Galaxy S24', brand: 'Samsung' });
      const archived = await createProduct({ name: 'Old TV', brand: 'LG' });
      await t.patch(`/admin/products/${archived}`, { status: 'ARCHIVED' }, admin.token).expect(200);

      const all = await t.get('/admin/products?limit=2', admin.token).expect(200);
      expect(all.body).toMatchObject({ total: 3, page: 1, limit: 2 });
      expect(all.body.items).toHaveLength(2);
      expect((await t.get('/admin/products?limit=2&page=2', admin.token)).body.items).toHaveLength(1);
      const names = async (query: string) =>
        (await t.get(`/admin/products?${query}`, admin.token).expect(200)).body.items.map(
          (p: { name: string }) => p.name,
        );
      expect(await names('status=ARCHIVED')).toEqual(['Old TV']);
      expect(await names('search=samsung')).toEqual(['Galaxy S24']);
      expect(await names('search=iphone')).toEqual(['iPhone 15']);
      expect((await t.get('/admin/products?limit=500', admin.token)).status).toBe(400);
    });

    it('keeps a product AVAILABLE while it has a scheduled or running auction', async () => {
      const productId = await createProduct();
      const auctionId = await createAuction({}, productId);
      await t.patch(`/admin/products/${productId}`, { status: 'UNAVAILABLE' }, admin.token).expect(200);
      const blocked = await act(auctionId, 'schedule');
      expect(blocked.status).toBe(422);
      expect(blocked.body.error).toBe('AUCTION_NOT_READY');

      await t.patch(`/admin/products/${productId}`, { status: 'AVAILABLE' }, admin.token).expect(200);
      await act(auctionId, 'schedule').expect(200);
      for (const next of ['ARCHIVED', 'UNAVAILABLE', 'RESERVED']) {
        const res = await t.patch(`/admin/products/${productId}`, { status: next }, admin.token);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('PRODUCT_IN_USE');
      }
      await t.patch(`/admin/products/${productId}`, { name: 'Still editable' }, admin.token).expect(200);

      await act(auctionId, 'cancel', { reason: 'No longer needed' }).expect(200);
      await t.patch(`/admin/products/${productId}`, { status: 'ARCHIVED' }, admin.token).expect(200);
    });
  });

  describe('authorization', () => {
    it('rejects anonymous callers and ordinary users on every admin route', async () => {
      const user = await account();
      const productId = await createProduct();
      const auctionId = await createAuction({}, productId);
      const before = await t.prisma.auditLog.count();
      const routes: ['get' | 'post' | 'patch', string, object?][] = [
        ['get', '/admin/products'],
        ['get', `/admin/products/${productId}`],
        ['post', '/admin/products', productBody()],
        ['patch', `/admin/products/${productId}`, { name: 'Hacked' }],
        ['get', '/admin/auctions'],
        ['get', `/admin/auctions/${auctionId}`],
        ['post', '/admin/auctions', auctionBody(productId)],
        ['patch', `/admin/auctions/${auctionId}`, { title: 'Hacked' }],
        ['post', `/admin/auctions/${auctionId}/schedule`],
        ['post', `/admin/auctions/${auctionId}/unschedule`],
        ['post', `/admin/auctions/${auctionId}/activate`],
        ['post', `/admin/auctions/${auctionId}/cancel`, { reason: 'Because I can' }],
      ];
      for (const [method, path, body] of routes) {
        const call = (token?: string) => (method === 'get' ? t.get(path, token) : t[method](path, body, token));
        expect([path, (await call()).status]).toEqual([path, 401]);
        const res = await call(user.token);
        expect([path, res.status, res.body.error]).toEqual([path, 403, 'FORBIDDEN']);
      }
      expect(await status(auctionId)).toBe('DRAFT');
      expect(await t.prisma.product.count()).toBe(1);
      expect(await t.prisma.auditLog.count()).toBe(before);
    });

    it('lets SUPPORT and FINANCE read but not change products or auctions', async () => {
      const productId = await createProduct();
      const auctionId = await createAuction({}, productId);
      for (const role of [RoleName.SUPPORT, RoleName.FINANCE]) {
        const staff = await account(role);
        await t.get('/admin/products', staff.token).expect(200);
        await t.get(`/admin/auctions/${auctionId}`, staff.token).expect(200);
        expect((await t.post('/admin/products', productBody(), staff.token)).status).toBe(403);
        expect((await t.patch(`/admin/auctions/${auctionId}`, { title: 'Nope nope' }, staff.token)).status).toBe(403);
        expect((await act(auctionId, 'activate', {}, staff.token)).status).toBe(403);
      }
      const root = await account(RoleName.SUPER_ADMIN);
      await act(auctionId, 'activate', {}, root.token).expect(200);
    });
  });

  describe('creating and editing auctions', () => {
    it('creates a draft that takes its currency from the product and is hidden from the public', async () => {
      const productId = await createProduct();
      const res = await t.post('/admin/auctions', auctionBody(productId), admin.token).expect(201);

      expect(res.body).toMatchObject({
        status: 'DRAFT',
        currency: 'ETB',
        minorUnits: 2,
        bidFeeMinor: '7500',
        bidFee: '75.00',
        minBid: '1.00',
        maxBid: '1000.00',
        bidStep: '1.00',
        maxBidsPerUser: null,
        maxBidsPerRequest: 50,
        duplicateBidPolicy: 'REJECT_SAME_USER_SAME_AMOUNT',
        noUniqueBidPolicy: 'NO_WINNER',
        totalBidCount: 0,
        productStatus: 'AVAILABLE',
        createdById: admin.id,
        product: { id: productId, name: 'Samsung Galaxy A55', marketValue: '65000.00' },
      });
      expect(Math.abs(Date.parse(res.body.serverTime) - Date.now())).toBeLessThan(60_000);
      expect(await t.prisma.auditLog.count({ where: { action: 'auction.create', entityId: res.body.id } })).toBe(1);

      expect((await t.get(`/auctions/${res.body.id}`)).status).toBe(404);
      expect((await t.get('/auctions').expect(200)).body.items).toEqual([]);
    });

    it.each([
      ['max below min', { minBidMinor: '500', maxBidMinor: '400' }, /greater than or equal to minBidMinor/],
      ['max off the step grid', { maxBidMinor: '100050' }, /whole number of bidStepMinor steps/],
      ['closing before opening', { opensAt: inHours(5), closesAt: inHours(4) }, /closesAt must be after opensAt/],
      ['a zero minimum bid', { minBidMinor: '0' }, /minBidMinor/],
      ['a numeric fee', { bidFeeMinor: 7500 }, /bidFeeMinor/],
      ['a date without a time zone', { opensAt: '2030-01-01T09:00:00' }, /time zone/],
      ['a date without a time', { opensAt: '2030-01-01' }, /time zone/],
      ['a policy that is not supported yet', { noUniqueBidPolicy: 'EXTEND_AUCTION' }, /noUniqueBidPolicy/],
      ['too many bids per request', { maxBidsPerRequest: 101 }, /maxBidsPerRequest/],
      ['a status set by the caller', { status: 'ACTIVE' }, /status/],
    ])('rejects %s', async (_name, override, message) => {
      const res = await t.post('/admin/auctions', auctionBody(await createProduct(), override), admin.token);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_FAILED');
      expect((res.body.details.fields as string[]).join('; ')).toMatch(message);
      expect(await t.prisma.auction.count()).toBe(0);
    });

    it('rejects unknown and archived products', async () => {
      expect((await t.post('/admin/auctions', auctionBody(randomUUID()), admin.token)).status).toBe(404);
      const productId = await createProduct({ status: 'ARCHIVED' });
      const res = await t.post('/admin/auctions', auctionBody(productId), admin.token);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('PRODUCT_NOT_AVAILABLE');
    });

    it('edits a draft, validating the merged rules, and audits the change', async () => {
      const id = await createAuction();

      const res = await t
        .patch(
          `/admin/auctions/${id}`,
          { title: 'New title', bidFeeMinor: '5000', maxBidsPerUser: 20, noUniqueBidPolicy: null },
          admin.token,
        )
        .expect(200);
      expect(res.body).toMatchObject({
        title: 'New title',
        bidFee: '50.00',
        maxBidsPerUser: 20,
        noUniqueBidPolicy: null,
        version: 1,
      });
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'auction.update' } });
      expect(audit.before).toMatchObject({ title: 'Win a Galaxy A55', bidFeeMinor: '7500' });
      expect(audit.after).toMatchObject({ title: 'New title', bidFeeMinor: '5000' });

      // 100 … 100000 in steps of 100: a new minimum of 150 leaves the maximum off the grid.
      const bad = await t.patch(`/admin/auctions/${id}`, { minBidMinor: '150' }, admin.token);
      expect(bad.status).toBe(400);
      expect(bad.body.details.fields).toEqual([expect.stringContaining('whole number of bidStepMinor steps')]);
      expect((await t.patch(`/admin/auctions/${id}`, {}, admin.token)).status).toBe(400);
      expect((await t.patch(`/admin/auctions/${id}`, { title: null }, admin.token)).status).toBe(400);
      expect((await t.patch(`/admin/auctions/${randomUUID()}`, { title: 'Nothing here' }, admin.token)).status).toBe(
        404,
      );
    });
  });

  describe('lifecycle', () => {
    it('schedules a draft, making it public, and can take it back', async () => {
      const id = await createAuction();

      const scheduled = await act(id, 'schedule').expect(200);
      expect(scheduled.body).toMatchObject({ status: 'SCHEDULED', activatedAt: null });
      const seen = await t.get(`/auctions/${id}`).expect(200);
      expect(seen.body).toMatchObject({ id, status: 'SCHEDULED', bidFee: '75.00', totalBidCount: 0 });
      expect(seen.body).not.toHaveProperty('createdById');
      expect(seen.body).not.toHaveProperty('version');
      expect(seen.body.product).not.toHaveProperty('status');

      const again = await act(id, 'schedule');
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('AUCTION_INVALID_STATE');

      await act(id, 'unschedule').expect(200);
      expect((await t.get(`/auctions/${id}`)).status).toBe(404);
      expect((await act(id, 'unschedule')).status).toBe(409);
      const actions = (
        await t.prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } })
      ).map((a) => a.action);
      expect(actions).toEqual(['auction.create', 'auction.schedule', 'auction.unschedule']);
    });

    it('will not publish an auction that is not ready, and says why', async () => {
      const id = await createAuction({ noUniqueBidPolicy: null });
      await shiftWindow(id, -2, -1);

      const res = await act(id, 'schedule');

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('AUCTION_NOT_READY');
      expect(res.body.details.problems).toEqual([
        expect.stringContaining('noUniqueBidPolicy'),
        expect.stringContaining('closesAt is in the past'),
        expect.stringContaining('opensAt is in the past'),
      ]);
      expect((await act(id, 'activate')).body.details.problems).toHaveLength(2);
      expect(await status(id)).toBe('DRAFT');
    });

    it('keeps a scheduled auction publishable when it is edited', async () => {
      const id = await createAuction();
      await act(id, 'schedule').expect(200);

      await t.patch(`/admin/auctions/${id}`, { bidFeeMinor: '9000', closesAt: inHours(48) }, admin.token).expect(200);
      const noPolicy = await t.patch(`/admin/auctions/${id}`, { noUniqueBidPolicy: null }, admin.token);
      expect(noPolicy.status).toBe(422);
      expect(noPolicy.body.error).toBe('AUCTION_NOT_READY');
      const past = await t.patch(`/admin/auctions/${id}`, { opensAt: inHours(-1) }, admin.token);
      expect(past.status).toBe(422);
      expect((await t.get(`/auctions/${id}`).expect(200)).body).toMatchObject({
        bidFee: '90.00',
        noUniqueBidPolicy: 'NO_WINNER',
      });
    });

    it('activates immediately, moving the opening time to now, and then locks the rules', async () => {
      const id = await createAuction();

      const res = await act(id, 'activate').expect(200);

      expect(res.body.status).toBe('ACTIVE');
      expect(Math.abs(Date.parse(res.body.opensAt) - Date.now())).toBeLessThan(60_000);
      expect(res.body.activatedAt).toEqual(res.body.opensAt);

      await t
        .patch(`/admin/auctions/${id}`, { title: 'Clearer title', description: 'More detail' }, admin.token)
        .expect(200);
      const locked = await t.patch(
        `/admin/auctions/${id}`,
        { title: 'Sneaky', bidFeeMinor: '1', closesAt: inHours(99) },
        admin.token,
      );
      expect(locked.status).toBe(409);
      expect(locked.body.error).toBe('AUCTION_INVALID_STATE');
      expect(locked.body.details.lockedFields).toEqual(['bidFeeMinor', 'closesAt']);
      expect((await t.get(`/auctions/${id}`)).body).toMatchObject({ title: 'Clearer title', bidFee: '75.00' });
      for (const action of ['activate', 'schedule', 'unschedule']) expect((await act(id, action)).status).toBe(409);
    });

    it('activates only once under concurrent requests', async () => {
      const id = await createAuction();
      const results = await Promise.all(Array.from({ length: 6 }, () => act(id, 'activate')));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      expect(await t.prisma.auditLog.count({ where: { action: 'auction.activate' } })).toBe(1);
    });

    it('cancels with a reason; a cancelled draft stays hidden, a cancelled live auction stays visible', async () => {
      const draft = await createAuction();
      expect((await act(draft, 'cancel', {})).status).toBe(400);
      const cancelled = await act(draft, 'cancel', { reason: 'Created by mistake' }).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Created by mistake' });
      expect(cancelled.body.cancelledAt).toEqual(expect.any(String));
      expect((await t.get(`/auctions/${draft}`)).status).toBe(404);
      for (const action of ['cancel', 'activate', 'schedule']) {
        expect((await act(draft, action, { reason: 'Second attempt' })).status).toBe(409);
      }
      expect((await t.patch(`/admin/auctions/${draft}`, { title: 'Too late' }, admin.token)).status).toBe(409);

      const live = await createAuction();
      await act(live, 'activate').expect(200);
      await act(live, 'cancel', { reason: 'Supplier fell through' }).expect(200);
      expect((await t.get(`/auctions/${live}`).expect(200)).body.status).toBe('CANCELLED');
      expect((await t.get('/auctions').expect(200)).body.items.map((a: { id: string }) => a.id)).toEqual([live]);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'auction.cancel', entityId: live } });
      expect(audit).toMatchObject({ actorId: admin.id, metadata: { reason: 'Supplier fell through' } });
    });
  });

  describe('automatic opening and closing', () => {
    it('opens scheduled auctions when due and closes active ones when their time is up', async () => {
      const [due, notDue, ending, running, draft] = await Promise.all(Array.from({ length: 5 }, () => createAuction()));
      for (const id of [due, notDue]) await act(id, 'schedule').expect(200);
      for (const id of [ending, running]) await act(id, 'activate').expect(200);
      await shiftWindow(due, -0.01, 10);
      await shiftWindow(ending, -5, -0.01);
      await shiftWindow(draft, -5, -1);

      const sweep = await lifecycle.syncDue();

      expect(sweep).toEqual({ activated: [due], closing: [ending] });
      expect(await Promise.all([due, notDue, ending, running, draft].map(status))).toEqual([
        'ACTIVE',
        'SCHEDULED',
        'CLOSING',
        'ACTIVE',
        'DRAFT',
      ]);
      const opened = await t.prisma.auction.findUniqueOrThrow({ where: { id: due } });
      expect(opened.activatedAt).toBeInstanceOf(Date);
      const closed = await t.prisma.auction.findUniqueOrThrow({ where: { id: ending } });
      expect(closed.closedAt).toBeInstanceOf(Date);
      const audits = await t.prisma.auditLog.findMany({ where: { actorType: 'SYSTEM' } });
      expect(audits.map((a) => [a.action, a.entityId]).sort()).toEqual([
        ['auction.activate', due],
        ['auction.close', ending],
      ]);

      expect(await lifecycle.syncDue()).toEqual({ activated: [], closing: [] });
      // Bidding is over: nothing about the auction can change any more.
      expect((await t.patch(`/admin/auctions/${ending}`, { title: 'After the bell' }, admin.token)).status).toBe(409);
      expect((await act(ending, 'cancel', { reason: 'Too late to cancel' })).status).toBe(409);
      expect((await t.get(`/auctions/${ending}`).expect(200)).body.status).toBe('CLOSING');
    });

    it('opens and closes in one pass an auction whose whole window was missed, and stays consistent under concurrent sweeps', async () => {
      const id = await createAuction();
      await act(id, 'schedule').expect(200);
      await shiftWindow(id, -3, -1);

      const sweeps = await Promise.all(Array.from({ length: 5 }, () => lifecycle.syncDue()));

      expect(sweeps.flatMap((s) => s.activated)).toEqual([id]);
      expect(sweeps.flatMap((s) => s.closing)).toEqual([id]);
      expect(await status(id)).toBe('CLOSING');
    });
  });

  describe('public listing', () => {
    it('lists public auctions with status filter, sorting and paging, and never drafts', async () => {
      const soon = await createAuction({ title: 'Ends soon', closesAt: inHours(3) });
      const later = await createAuction({ title: 'Ends later', closesAt: inHours(30) });
      const upcoming = await createAuction({ title: 'Upcoming', opensAt: inHours(2), closesAt: inHours(20) });
      await createAuction({ title: 'Still a draft' });
      await act(soon, 'activate').expect(200);
      await act(later, 'activate').expect(200);
      await act(upcoming, 'schedule').expect(200);

      const titles = async (query = '') =>
        (await t.get(`/auctions${query}`).expect(200)).body.items.map((a: { title: string }) => a.title);
      expect(await titles()).toEqual(['Ends soon', 'Upcoming', 'Ends later']);
      expect(await titles('?status=ACTIVE')).toEqual(['Ends soon', 'Ends later']);
      expect(await titles('?status=ACTIVE&order=desc')).toEqual(['Ends later', 'Ends soon']);
      expect(await titles('?status=SCHEDULED')).toEqual(['Upcoming']);
      expect(await titles('?status=COMPLETED')).toEqual([]);
      const page = await t.get('/auctions?limit=2&page=2').expect(200);
      expect(page.body).toMatchObject({ total: 3, page: 2, limit: 2 });
      expect(page.body.items).toHaveLength(1);

      for (const query of ['?status=DRAFT', '?status=CANCELLED', '?sort=bidFeeMinor', '?limit=0']) {
        expect((await t.get(`/auctions${query}`)).status).toBe(400);
      }
      expect((await t.get('/auctions/not-a-uuid')).status).toBe(400);

      const adminView = await t.get('/admin/auctions?status=DRAFT', admin.token).expect(200);
      expect(adminView.body.items.map((a: { title: string }) => a.title)).toEqual(['Still a draft']);
      expect((await t.get('/admin/auctions?search=ends', admin.token)).body.total).toBe(2);
    });
  });
});

describe('Auction lifecycle background job', () => {
  it('opens a due auction without any request', async () => {
    const t = await createTestApp({ AUCTION_SWEEP_INTERVAL_SECONDS: '1' });
    try {
      await t.reset();
      // reset() empties Redis, which also holds the job schedule: register it again.
      await t.app.get(AuctionLifecycleProcessor).onApplicationBootstrap();
      const product = await t.prisma.product.create({
        data: { name: 'Prize', marketValueMinor: 1000n, currency: 'ETB' },
      });
      const auction = await t.prisma.auction.create({
        data: {
          productId: product.id,
          title: 'Opens by itself',
          currency: 'ETB',
          bidFeeMinor: 100n,
          minBidMinor: 100n,
          maxBidMinor: 1000n,
          opensAt: new Date(Date.now() - 1000),
          closesAt: new Date(Date.now() + HOUR),
          status: 'SCHEDULED',
          noUniqueBidPolicy: 'NO_WINNER',
        },
      });

      let current = 'SCHEDULED';
      for (let i = 0; i < 100 && current === 'SCHEDULED'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        current = (await t.prisma.auction.findUniqueOrThrow({ where: { id: auction.id } })).status;
      }
      expect(current).toBe('ACTIVE');
    } finally {
      await t.close();
    }
  });
});
