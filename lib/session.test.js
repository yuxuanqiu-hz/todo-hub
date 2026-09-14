'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadSession(env) {
  for (const key of ['SITE_PASSWORD', 'SITE_SESSION_SECRET', 'VERCEL', 'NODE_ENV']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  delete require.cache[require.resolve('./session')];
  return require('./session');
}

function mockRes() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('unconfigured site refuses session and password checks', () => {
  const session = loadSession({});
  assert.equal(session.isConfigured(), false);
  assert.equal(session.verifyPassword('anything'), false);
  assert.equal(session.verifyToken('v1.1.abc.def'), false);

  const res = mockRes();
  const ok = session.requireSession({ headers: {} }, res);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'unconfigured');
});

test('wrong password is rejected; correct password issues a verifiable cookie', () => {
  const session = loadSession({
    SITE_PASSWORD: 'correct-horse',
    SITE_SESSION_SECRET: 'independent-secret',
  });
  assert.equal(session.verifyPassword('wrong'), false);
  assert.equal(session.verifyPassword('correct-horse'), true);

  const now = Date.now();
  const token = session.createToken(now);
  assert.equal(session.verifyToken(token, now), true);
  assert.equal(session.verifyToken(token + 'x', now), false);
  assert.equal(session.verifyToken(token, now + session.MAX_AGE_SEC * 1000 + 1), false);

  const res = mockRes();
  session.setSessionCookie(res, token);
  assert.match(res.headers['set-cookie'], new RegExp(`${session.COOKIE_NAME}=`));
  assert.match(res.headers['set-cookie'], /HttpOnly/);
  assert.match(res.headers['set-cookie'], /SameSite=Lax/);
  assert.doesNotMatch(res.headers['set-cookie'], /Secure/);

  const req = { headers: { cookie: res.headers['set-cookie'].split(';')[0] } };
  const guarded = mockRes();
  assert.equal(session.requireSession(req, guarded), true);
  assert.equal(guarded.statusCode, 200);
});

test('production / Vercel cookies are marked Secure', () => {
  const session = loadSession({
    SITE_PASSWORD: 'pw',
    SITE_SESSION_SECRET: 'sec',
    VERCEL: '1',
  });
  const res = mockRes();
  session.setSessionCookie(res, session.createToken());
  assert.match(res.headers['set-cookie'], /Secure/);
});

test('changing the site password invalidates existing tokens', () => {
  const session = loadSession({
    SITE_PASSWORD: 'old-password',
    SITE_SESSION_SECRET: 'independent-secret',
  });
  const token = session.createToken();
  const next = loadSession({
    SITE_PASSWORD: 'new-password',
    SITE_SESSION_SECRET: 'independent-secret',
  });
  assert.equal(next.verifyToken(token), false);
});

test('derived secret still signs tokens when SITE_SESSION_SECRET is absent', () => {
  const session = loadSession({ SITE_PASSWORD: 'only-password' });
  assert.equal(session.usesDerivedSessionSecret(), true);
  const token = session.createToken();
  assert.equal(session.verifyToken(token), true);
});
