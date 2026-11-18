import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { buildOpenApiDocument } from '../src/app.setup';
import { createTestApp, TestApp } from './helpers/test-app';

/** The only routes that work without signing in. Adding one here is a deliberate decision. */
const PUBLIC_ROUTES = [
  'GET /health',
  'GET /health/ready',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/verify-phone',
  'POST /api/v1/auth/resend-verification',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/reset-password',
  'GET /api/v1/auctions',
  'GET /api/v1/auctions/:id',
  'GET /api/v1/auctions/:id/result',
  'GET /api/v1/winners',
  'GET /api/v1/wallet/deposit-options',
  'GET /api/v1/winners/:id',
  // Called by the payment provider, not by a user. The webhook is checked by its signature instead.
  'POST /api/v1/payments/chapa/webhook',
  'GET /api/v1/payments/chapa/callback',
];

interface Route {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  name: string;
}
interface Operation {
  summary?: string;
  tags?: string[];
  security?: object[];
  responses: Record<string, { description?: string; content?: object }>;
}

describe('API contract', () => {
  let t: TestApp;
  let routes: Route[];
  let operations: Map<string, Operation>;
  let userToken: string;

  beforeAll(async () => {
    t = await createTestApp({ PHONE_VERIFICATION_REQUIRED: 'false', OTP_PROVIDER: 'none' });
    await t.reset();

    // The handlers the server really has, read from the controllers rather than from the documentation.
    routes = new DiscoveryService(t.app.get(ModulesContainer)).getControllers().flatMap(({ instance }) => {
      const prototype = Object.getPrototypeOf(instance) as Record<string, object>;
      const base = Reflect.getMetadata(PATH_METADATA, prototype.constructor) as string;
      const prefix = base.startsWith('health') ? '' : '/api/v1';
      return Object.getOwnPropertyNames(prototype).flatMap((key) => {
        const verb = Reflect.getMetadata(METHOD_METADATA, prototype[key]) as RequestMethod | undefined;
        if (verb === undefined) return [];
        const method = RequestMethod[verb].toLowerCase() as Route['method'];
        const own = Reflect.getMetadata(PATH_METADATA, prototype[key]) as string;
        const path = [prefix, base, own].join('/').replace(/\/+/g, '/').replace(/\/$/, '');
        return [{ method, path, name: `${method.toUpperCase()} ${path}` }];
      });
    });

    operations = new Map();
    const document = buildOpenApiDocument(t.app);
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item as Record<string, Operation>)) {
        operations.set(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`, operation);
      }
    }

    const res = await t.post('/auth/register', { phoneNumber: '+251911000001', password: 'Str0ngPassw0rd' });
    userToken = res.body.tokens.accessToken;
  });
  afterAll(async () => {
    await t.close();
  });

  const call = (route: Route, token?: string) => {
    const req = request(t.app.getHttpServer())[route.method](route.path.replace(/:\w+/g, randomUUID())).send({});
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const protectedRoutes = () => routes.filter((r) => !PUBLIC_ROUTES.includes(r.name));

  it('serves the routes it is expected to serve', () => {
    expect(routes.length).toBeGreaterThan(70);
    for (const name of PUBLIC_ROUTES) expect(routes.map((r) => r.name)).toContain(name);
  });

  it('refuses every other route without a valid access token', async () => {
    for (const route of protectedRoutes()) {
      for (const token of [undefined, 'not-a-token']) {
        const res = await call(route, token);
        expect({ route: route.name, status: res.status, error: res.body.error }).toEqual({
          route: route.name,
          status: 401,
          error: 'UNAUTHORIZED',
        });
      }
    }
  });

  it('refuses every back-office route to an ordinary user and changes nothing', async () => {
    const adminRoutes = routes.filter((r) => r.path.includes('/admin/'));
    expect(adminRoutes.length).toBeGreaterThan(40);
    for (const route of adminRoutes) {
      const res = await call(route, userToken).set('Idempotency-Key', randomUUID());
      expect({ route: route.name, status: res.status, error: res.body.error }).toEqual({
        route: route.name,
        status: 403,
        error: 'FORBIDDEN',
      });
    }
    expect(await t.prisma.auditLog.count()).toBe(0);
    expect(await t.prisma.userRole.count({ where: { role: { name: { not: 'USER' } } } })).toBe(0);
  });

  it('documents every route, and nothing that does not exist', () => {
    expect([...operations.keys()].sort()).toEqual(routes.map((r) => r.name).sort());
  });

  it('documents each route with a summary, a tag, who may call it and its errors', () => {
    const problems: string[] = [];
    for (const [name, operation] of operations) {
      const responses = operation.responses;
      const isPublic = PUBLIC_ROUTES.includes(name);
      if (!operation.summary) problems.push(`${name}: no summary`);
      if (!operation.tags?.length) problems.push(`${name}: no tag`);
      if (!Object.keys(responses).some((code) => code.startsWith('2'))) problems.push(`${name}: no success response`);
      if (isPublic === Boolean(operation.security?.length)) problems.push(`${name}: wrong security requirement`);
      if (!isPublic && !responses['401']) problems.push(`${name}: 401 not documented`);
      if (name.includes('/admin/') && !responses['403']) problems.push(`${name}: 403 not documented`);
      if (name.includes(':') && !responses['400'] && !responses['404']) problems.push(`${name}: no 400 or 404`);
      for (const [code, response] of Object.entries(responses)) {
        if (!code.startsWith('2') && !response.description) problems.push(`${name}: ${code} has no description`);
        if (code !== '204' && !response.content) problems.push(`${name}: ${code} has no body schema`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every documented field a real type, so generated clients accept what the server sends', () => {
    // Without an explicit type a `string | null` field is documented as an object with no content, and a
    // free-form object must say that it accepts any keys.
    const schemas = buildOpenApiDocument(t.app).components?.schemas ?? {};
    const problems = Object.entries(schemas).flatMap(([schema, definition]) =>
      Object.entries(('properties' in definition && definition.properties) || {})
        .filter(
          ([, property]) =>
            'type' in property &&
            property.type === 'object' &&
            !property.properties &&
            !property.additionalProperties &&
            !property.allOf,
        )
        .map(([name]) => `${schema}.${name}`),
    );
    expect(problems).toEqual([]);
  });

  it('sends security headers and does not reveal the framework', async () => {
    const res = await t.get('/auctions').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('answers a cross-origin request only for an allowed origin', async () => {
    const res = await t.get('/auctions').set('Origin', 'https://evil.example').expect(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns errors in one shape without internals', async () => {
    const unknown = await t.get('/no-such-route').expect(404);
    expect(Object.keys(unknown.body).sort()).toEqual(
      ['error', 'message', 'path', 'requestId', 'statusCode', 'timestamp'].sort(),
    );

    const malformed = await request(t.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"phoneNumber": ')
      .expect(400);
    expect(JSON.stringify(malformed.body)).not.toMatch(/stack|node_modules|\.ts:|\.js:/);

    const injected = await t
      .post('/auth/login', { phoneNumber: "+251911000001' OR '1'='1", password: { $ne: null } })
      .expect(400);
    expect(injected.body.error).toBe('VALIDATION_FAILED');
  });

  it('refuses a request body that is too large', async () => {
    const res = await t.post('/auth/login', { phoneNumber: '+251911000001', password: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('PAYLOAD_TOO_LARGE');
  });
});
