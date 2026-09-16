'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadTodos(env) {
  for (const key of ['SITE_PASSWORD', 'SITE_SESSION_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL', 'NODE_ENV']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../lib/session')];
  delete require.cache[require.resolve('../lib/kb')];
  delete require.cache[require.resolve('../lib/quotes')];
  delete require.cache[require.resolve('../lib/trades')];
  delete require.cache[require.resolve('./auth')];
  delete require.cache[require.resolve('./todos')];
  return {
    todos: require('./todos'),
    session: require('../lib/session'),
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

function installKvMock() {
  const strings = new Map();
  const sets = new Map();
  const prev = global.fetch;
  global.fetch = async (url, opts = {}) => {
    let cmd;
    if (opts.method === 'POST' && opts.body) {
      cmd = JSON.parse(opts.body);
    } else {
      const parsed = new URL(String(url));
      cmd = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    }
    const [op, a, b] = cmd;
    let result = null;
    if (op === 'set') {
      strings.set(a, b);
      result = 'OK';
    } else if (op === 'get') {
      result = strings.has(a) ? strings.get(a) : null;
    } else if (op === 'del') {
      strings.delete(a);
      result = 1;
    } else if (op === 'sadd') {
      if (!sets.has(a)) sets.set(a, new Set());
      sets.get(a).add(b);
      result = 1;
    } else if (op === 'srem') {
      if (sets.has(a)) sets.get(a).delete(b);
      result = 1;
    } else if (op === 'smembers') {
      result = sets.has(a) ? [...sets.get(a)] : [];
    } else {
      throw new Error(`unexpected kv op ${op}`);
    }
    return {
      ok: true,
      json: async () => ({ result }),
      text: async () => '',
    };
  };
  return {
    strings,
    restore() {
      global.fetch = prev;
    },
  };
}

test('kb POST keeps the same id on edit and does not rewrite file unless replaced', async () => {
  const { todos, session } = loadTodos({
    SITE_PASSWORD: 'gate-password',
    SITE_SESSION_SECRET: 'gate-secret',
    KV_REST_API_URL: 'https://kv.example',
    KV_REST_API_TOKEN: 'tok',
  });
  const kv = installKvMock();
  const cookie = `th_session=${encodeURIComponent(session.createToken())}`;
  try {
    const created = mockRes();
    await todos({
      method: 'POST',
      headers: { cookie },
      query: { resource: 'kb' },
      body: {
        id: 'k-keep',
        title: '身份证',
        category: 'id',
        note: '家里',
        fields: [{ label: '号码', value: '110' }],
      },
    }, created);
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.item.id, 'k-keep');
    assert.equal(created.body.item.title, '身份证');

    const edited = mockRes();
    await todos({
      method: 'POST',
      headers: { cookie },
      query: { resource: 'kb' },
      body: {
        id: 'k-keep',
        title: '身份证（新）',
        category: 'account',
        note: '公司',
        fields: [
          { label: '账号', value: 'n@x.com' },
          { label: '密码', value: 'secret' },
        ],
      },
    }, edited);
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.body.item.id, 'k-keep');
    assert.equal(edited.body.item.title, '身份证（新）');
    assert.equal(edited.body.item.category, 'account');
    assert.deepEqual(edited.body.item.fields, [
      { label: '账号', value: 'n@x.com' },
      { label: '密码', value: 'secret' },
    ]);
    assert.equal(edited.body.item.createdAt, created.body.item.createdAt);

    const listed = mockRes();
    await todos({ method: 'GET', headers: { cookie }, query: { resource: 'kb' } }, listed);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].id, 'k-keep');
    assert.equal(listed.body[0].title, '身份证（新）');

    const fileCreated = mockRes();
    await todos({
      method: 'POST',
      headers: { cookie },
      query: { resource: 'kb' },
      body: {
        id: 'k-file',
        title: '护照',
        category: 'file',
        fileData: 'Zm9v',
        fileName: 'old.png',
        fileMime: 'image/png',
        fileSize: 3,
      },
    }, fileCreated);
    assert.equal(fileCreated.statusCode, 200);
    const storedFile = JSON.parse(kv.strings.get('kb:file:k-file'));
    assert.equal(storedFile.fileData, 'Zm9v');

    const renamed = mockRes();
    await todos({
      method: 'POST',
      headers: { cookie },
      query: { resource: 'kb' },
      body: {
        id: 'k-file',
        title: '护照 2024',
        category: 'file',
        hasFile: true,
        fileName: 'old.png',
        fileMime: 'image/png',
        fileSize: 3,
      },
    }, renamed);
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.body.item.id, 'k-file');
    assert.equal(renamed.body.item.title, '护照 2024');
    assert.equal(JSON.parse(kv.strings.get('kb:file:k-file')).fileData, 'Zm9v');

    const replaced = mockRes();
    await todos({
      method: 'POST',
      headers: { cookie },
      query: { resource: 'kb' },
      body: {
        id: 'k-file',
        title: '护照 2024',
        category: 'file',
        fileData: 'bmV3',
        fileName: 'new.png',
        fileMime: 'image/png',
        fileSize: 3,
      },
    }, replaced);
    assert.equal(replaced.statusCode, 200);
    assert.equal(JSON.parse(kv.strings.get('kb:file:k-file')).fileData, 'bmV3');
    assert.equal(JSON.parse(kv.strings.get('kb:file:k-file')).fileName, 'new.png');
  } finally {
    kv.restore();
  }
});
