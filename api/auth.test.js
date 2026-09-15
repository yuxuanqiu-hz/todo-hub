'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadAuth(env) {
  for (const key of ['SITE_PASSWORD', 'SITE_SESSION_SECRET', 'VERCEL', 'NODE_ENV']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../lib/session')];
  delete require.cache[require.resolve('./auth')];
  delete require.cache[require.resolve('./todos')];
  return {
    auth: require('./auth'),
    session: require('../lib/session'),
    todos: require('./todos'),
  };
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

test('auth GET/POST refuse access when SITE_PASSWORD is missing', async () => {
  const { auth } = loadAuth({});
  const getRes = mockRes();
  await auth({ method: 'GET', headers: {} }, getRes);
  assert.equal(getRes.statusCode, 503);

  const postRes = mockRes();
  await auth({ method: 'POST', headers: {}, body: { password: 'x' } }, postRes);
  assert.equal(postRes.statusCode, 503);
});

test('auth login sets cookie; status and protected APIs accept it', async () => {
  const { auth, session, todos } = loadAuth({
    SITE_PASSWORD: 'gate-password',
    SITE_SESSION_SECRET: 'gate-secret',
  });

  const denied = mockRes();
  await auth({ method: 'GET', headers: {} }, denied);
  assert.equal(denied.statusCode, 401);

  const badLogin = mockRes();
  await auth({ method: 'POST', headers: {}, body: { password: 'nope' } }, badLogin);
  assert.equal(badLogin.statusCode, 401);
  assert.equal(badLogin.headers['set-cookie'], undefined);

  const login = mockRes();
  await auth({ method: 'POST', headers: {}, body: { password: 'gate-password' } }, login);
  assert.equal(login.statusCode, 200);
  assert.match(login.headers['set-cookie'], /HttpOnly/);
  assert.match(login.headers['set-cookie'], /SameSite=Lax/);
  const cookiePair = login.headers['set-cookie'].split(';')[0];

  const status = mockRes();
  await auth({ method: 'GET', headers: { cookie: cookiePair } }, status);
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.body, { ok: true });

  const blockedTodos = mockRes();
  await todos({ method: 'GET', headers: {}, query: {} }, blockedTodos);
  assert.equal(blockedTodos.statusCode, 401);

  const blockedTrades = mockRes();
  await todos({ method: 'GET', headers: {}, query: { resource: 'trades' } }, blockedTrades);
  assert.equal(blockedTrades.statusCode, 401);

  const blockedMarks = mockRes();
  await todos({ method: 'POST', headers: {}, query: { resource: 'trade-marks' }, body: {} }, blockedMarks);
  assert.equal(blockedMarks.statusCode, 401);

  const allowedTodos = mockRes();
  await todos({ method: 'GET', headers: { cookie: cookiePair }, query: { resource: 'kb' } }, allowedTodos);
  assert.notEqual(allowedTodos.statusCode, 401);
  assert.equal(allowedTodos.body.error !== 'unauthorized', true);

  const allowedTrades = mockRes();
  await todos({ method: 'GET', headers: { cookie: cookiePair }, query: { resource: 'trades' } }, allowedTrades);
  assert.notEqual(allowedTrades.statusCode, 401);
  assert.equal(allowedTrades.body.error !== 'unauthorized', true);

  const logout = mockRes();
  await auth({ method: 'DELETE', headers: { cookie: cookiePair } }, logout);
  assert.equal(logout.statusCode, 200);
  assert.match(logout.headers['set-cookie'], /Max-Age=0/);
  assert.equal(session.verifyToken(decodeURIComponent(cookiePair.split('=')[1])), true);
});
