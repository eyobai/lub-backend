import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RoleName } from '@prisma/client';
import request from 'supertest';
import { createTestApp, TestApp } from './helpers/test-app';

const PASSWORD = 'Str0ngPassw0rd!';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const STORAGE = {
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  UPLOADS_BUCKET: 'leyubid-images',
  UPLOADS_ACCESS_KEY_ID: 'test-key-id',
  UPLOADS_SECRET_ACCESS_KEY: 'test-secret',
  UPLOADS_PUBLIC_URL: 'https://images.leyubid.com/',
  UPLOADS_MAX_MB: '1',
};

describe('Product picture uploads', () => {
  let phoneCounter = 0;

  async function signIn(t: TestApp, role?: RoleName): Promise<string> {
    const phoneNumber = `+2519${String(70000000 + ++phoneCounter)}`;
    const res = await t.post('/auth/register', { phoneNumber, password: PASSWORD }).expect(201);
    if (role) {
      const found = await t.prisma.role.findUniqueOrThrow({ where: { name: role } });
      await t.prisma.userRole.create({ data: { userId: res.body.userId, roleId: found.id } });
    }
    return res.body.tokens.accessToken as string;
  }

  const upload = (t: TestApp, token: string, file: Buffer, name = 'prize.jpg') =>
    request(t.app.getHttpServer())
      .post('/api/v1/admin/uploads/images')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', file, name);

  describe('with storage set up', () => {
    let t: TestApp;
    const sent: PutObjectCommand[] = [];
    let fail = false;

    beforeAll(async () => {
      const fakeSend = (command: unknown): Promise<object> => {
        if (fail) return Promise.reject(new Error('R2 is down'));
        sent.push(command as PutObjectCommand);
        return Promise.resolve({});
      };
      jest.spyOn(S3Client.prototype, 'send').mockImplementation(fakeSend as never);
      t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none', ...STORAGE });
    });
    afterAll(async () => {
      jest.restoreAllMocks();
      await t.close();
      for (const key of Object.keys(STORAGE)) delete process.env[key];
    });
    beforeEach(async () => {
      await t.reset();
      sent.length = 0;
      fail = false;
    });

    it('stores a picture under a fresh name and returns its public address', async () => {
      const admin = await signIn(t, RoleName.ADMIN);
      expect((await t.get('/admin/uploads/settings', admin).expect(200)).body).toEqual({
        enabled: true,
        maxBytes: 1024 * 1024,
        contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
      });

      const res = await upload(t, admin, JPEG, 'whatever.png').expect(201);
      expect(res.body).toEqual({
        url: expect.stringMatching(/^https:\/\/images\.leyubid\.com\/products\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/),
        key: expect.stringMatching(/^products\//),
        contentType: 'image/jpeg',
        sizeBytes: JPEG.length,
      });
      expect(sent).toHaveLength(1);
      expect(sent[0].input).toMatchObject({
        Bucket: 'leyubid-images',
        Key: res.body.key,
        ContentType: 'image/jpeg',
      });
    });

    it('refuses what is not a picture, a picture too large, and no file at all', async () => {
      const admin = await signIn(t, RoleName.ADMIN);
      const svg = await upload(t, admin, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.jpg');
      expect(svg.status).toBe(415);
      expect(svg.body.error).toBe('UNSUPPORTED_IMAGE');

      const big = await upload(t, admin, Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)]));
      expect(big.status).toBe(413);
      expect(big.body.error).toBe('PAYLOAD_TOO_LARGE');

      const none = await request(t.app.getHttpServer())
        .post('/api/v1/admin/uploads/images')
        .set('Authorization', `Bearer ${admin}`)
        .field('note', 'no file');
      expect(none.status).toBe(400);
      expect(sent).toHaveLength(0);
    });

    it('says so when the storage service fails', async () => {
      const admin = await signIn(t, RoleName.ADMIN);
      fail = true;
      const res = await upload(t, admin, JPEG);
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('UPLOAD_FAILED');
    });

    it('lets only admins upload', async () => {
      for (const role of [undefined, RoleName.SUPPORT, RoleName.FINANCE]) {
        expect((await upload(t, await signIn(t, role), JPEG)).status).toBe(403);
      }
      expect((await request(t.app.getHttpServer()).post('/api/v1/admin/uploads/images')).status).toBe(401);
      expect(sent).toHaveLength(0);
    });
  });

  describe('without storage', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
    });
    afterAll(async () => {
      await t.close();
    });

    it('reports uploads as off and refuses them', async () => {
      await t.reset();
      const admin = await signIn(t, RoleName.ADMIN);
      expect((await t.get('/admin/uploads/settings', admin).expect(200)).body.enabled).toBe(false);
      const res = await upload(t, admin, JPEG);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('UPLOADS_UNAVAILABLE');
    });
  });
});
