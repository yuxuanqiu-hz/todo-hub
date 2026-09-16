'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_FILEDATA_CHARS, sanitizeKbUpsert } = require('./kb');

test('rejects missing id or title', () => {
  assert.equal(sanitizeKbUpsert(null).ok, false);
  assert.equal(sanitizeKbUpsert({ title: '身份证' }).error, 'missing id');
  assert.equal(sanitizeKbUpsert({ id: 'k1' }).error, 'missing title');
  assert.equal(sanitizeKbUpsert({ id: 'k1', title: '   ' }).error, 'missing title');
});

test('creates a text item and keeps id/createdAt on edit', () => {
  const created = sanitizeKbUpsert({
    id: 'k1',
    title: ' 身份证 ',
    category: 'id',
    note: '家里抽屉',
    fields: [
      { label: '号码', value: '110101' },
      { label: '  ', value: '  ' },
      { label: '有效期', value: '2030' },
    ],
  }, null, 1000);

  assert.equal(created.ok, true);
  assert.deepEqual(created.meta, {
    id: 'k1',
    title: '身份证',
    category: 'id',
    note: '家里抽屉',
    fields: [
      { label: '号码', value: '110101' },
      { label: '有效期', value: '2030' },
    ],
    fileName: null,
    fileSize: null,
    fileMime: null,
    hasFile: false,
    createdAt: 1000,
    updatedAt: 1000,
  });
  assert.equal(created.file, null);
  assert.equal(created.deleteFile, false);

  const edited = sanitizeKbUpsert({
    id: 'k1',
    title: '户口本',
    category: 'account',
    note: '新备注',
    fields: [{ label: '账号', value: 'abc' }],
  }, created.meta, 2000);

  assert.equal(edited.ok, true);
  assert.equal(edited.meta.id, 'k1');
  assert.equal(edited.meta.title, '户口本');
  assert.equal(edited.meta.category, 'account');
  assert.equal(edited.meta.note, '新备注');
  assert.deepEqual(edited.meta.fields, [{ label: '账号', value: 'abc' }]);
  assert.equal(edited.meta.createdAt, 1000);
  assert.equal(edited.meta.updatedAt, 2000);
});

test('file create requires payload; edit without fileData keeps stored file', () => {
  const missing = sanitizeKbUpsert({
    id: 'k2',
    title: '护照扫描',
    category: 'file',
  }, null, 10);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'missing file');

  const created = sanitizeKbUpsert({
    id: 'k2',
    title: '护照扫描',
    category: 'file',
    fileData: 'Zm9v',
    fileName: 'passport.png',
    fileMime: 'image/png',
    fileSize: 12,
  }, null, 10);
  assert.equal(created.ok, true);
  assert.equal(created.meta.hasFile, true);
  assert.equal(created.file.fileData, 'Zm9v');
  assert.equal(created.deleteFile, false);

  const renamed = sanitizeKbUpsert({
    id: 'k2',
    title: '护照 2024',
    category: 'file',
    hasFile: true,
    fileName: 'passport.png',
    fileMime: 'image/png',
    fileSize: 12,
  }, created.meta, 20);
  assert.equal(renamed.ok, true);
  assert.equal(renamed.meta.id, 'k2');
  assert.equal(renamed.meta.title, '护照 2024');
  assert.equal(renamed.meta.fileName, 'passport.png');
  assert.equal(renamed.file, null);
  assert.equal(renamed.deleteFile, false);
  assert.equal(renamed.meta.createdAt, 10);
  assert.equal(renamed.meta.updatedAt, 20);
});

test('replacing a file updates storage payload', () => {
  const existing = {
    id: 'k3',
    title: '合同',
    category: 'file',
    hasFile: true,
    fileName: 'old.pdf',
    fileMime: 'application/pdf',
    fileSize: 8,
    createdAt: 5,
  };
  const replaced = sanitizeKbUpsert({
    id: 'k3',
    title: '合同',
    category: 'file',
    fileData: 'bmV3',
    fileName: 'new.pdf',
    fileMime: 'application/pdf',
    fileSize: 4,
  }, existing, 9);

  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.file, {
    fileData: 'bmV3',
    fileName: 'new.pdf',
    fileMime: 'application/pdf',
    fileSize: 4,
  });
  assert.equal(replaced.meta.fileName, 'new.pdf');
  assert.equal(replaced.deleteFile, false);
});

test('changing a file item to a text category deletes stored file', () => {
  const existing = {
    id: 'k4',
    title: '扫描件',
    category: 'file',
    hasFile: true,
    fileName: 'scan.jpg',
    createdAt: 1,
  };
  const changed = sanitizeKbUpsert({
    id: 'k4',
    title: '扫描件备注',
    category: 'id',
    note: '改成文字',
    fields: [{ label: '号码', value: '1' }],
  }, existing, 2);

  assert.equal(changed.ok, true);
  assert.equal(changed.meta.category, 'id');
  assert.equal(changed.meta.hasFile, false);
  assert.equal(changed.meta.fileName, null);
  assert.equal(changed.deleteFile, true);
  assert.deepEqual(changed.meta.fields, [{ label: '号码', value: '1' }]);
});

test('rejects oversized file payloads', () => {
  const result = sanitizeKbUpsert({
    id: 'k5',
    title: '太大',
    category: 'file',
    fileData: 'x'.repeat(MAX_FILEDATA_CHARS + 1),
    fileName: 'big.bin',
  }, null, 1);
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
  assert.equal(result.error, 'file too large');
});
