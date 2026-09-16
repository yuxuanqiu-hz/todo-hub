'use strict';

const KB_CATEGORIES = {
  id: '证件号码',
  account: '账号密码',
  file: '文件',
};

// 文件以 base64 存在 KV 里。Vercel Hobby 请求体约 4.5MB，
// 这里限制原始文件 1.5MB（base64 约 2MB），避免同步接口被撑爆。
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const MAX_FILEDATA_CHARS = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 64;

function asString(value) {
  return value == null ? '' : String(value);
}

function toFileSize(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function sanitizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields
    .map((field) => ({
      label: asString(field && field.label).trim(),
      value: asString(field && field.value).trim(),
    }))
    .filter((field) => field.label || field.value);
}

function normalizeCategory(category) {
  const key = asString(category).trim();
  return KB_CATEGORIES[key] ? key : null;
}

function hasStoredFile(existing) {
  if (!existing || typeof existing !== 'object') return false;
  return !!(existing.hasFile || existing.fileData || existing.fileName);
}

function sanitizeKbUpsert(input, existing, now = Date.now()) {
  if (!input || typeof input !== 'object') {
    return { ok: false, status: 400, error: 'missing item' };
  }

  const id = asString(input.id).trim();
  if (!id) {
    return { ok: false, status: 400, error: 'missing id' };
  }

  const title = asString(input.title).trim();
  if (!title) {
    return { ok: false, status: 400, error: 'missing title' };
  }

  const category = normalizeCategory(input.category)
    || (existing && normalizeCategory(existing.category))
    || 'id';
  const createdAt = Number(existing && existing.createdAt) || Number(input.createdAt) || now;
  const fileData = input.fileData != null && String(input.fileData) !== ''
    ? String(input.fileData)
    : null;

  if (fileData != null && fileData.length > MAX_FILEDATA_CHARS) {
    return { ok: false, status: 413, error: 'file too large', maxBytes: MAX_FILE_BYTES };
  }

  if (category === 'file') {
    const replacing = !!fileData;
    const keep = !replacing && hasStoredFile(existing);
    if (!replacing && !keep) {
      return { ok: false, status: 400, error: 'missing file' };
    }

    const source = replacing ? input : (existing || input);
    const meta = {
      id,
      title,
      category,
      note: '',
      fields: [],
      fileName: asString(source.fileName) || asString(existing && existing.fileName),
      fileSize: toFileSize(source.fileSize != null ? source.fileSize : existing && existing.fileSize),
      fileMime: asString(source.fileMime) || asString(existing && existing.fileMime) || 'application/octet-stream',
      hasFile: true,
      createdAt,
      updatedAt: now,
    };

    if (replacing) {
      meta.fileName = asString(input.fileName);
      meta.fileSize = toFileSize(input.fileSize);
      meta.fileMime = asString(input.fileMime) || 'application/octet-stream';
    }

    return {
      ok: true,
      meta,
      file: replacing
        ? {
          fileData,
          fileName: meta.fileName,
          fileMime: meta.fileMime,
          fileSize: meta.fileSize,
        }
        : null,
      deleteFile: false,
    };
  }

  return {
    ok: true,
    meta: {
      id,
      title,
      category,
      note: asString(input.note),
      fields: sanitizeFields(input.fields),
      fileName: null,
      fileSize: null,
      fileMime: null,
      hasFile: false,
      createdAt,
      updatedAt: now,
    },
    file: null,
    deleteFile: hasStoredFile(existing),
  };
}

module.exports = {
  KB_CATEGORIES,
  MAX_FILE_BYTES,
  MAX_FILEDATA_CHARS,
  sanitizeKbUpsert,
};
