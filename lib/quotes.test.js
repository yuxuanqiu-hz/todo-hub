'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_SYMBOLS,
  fetchQuotes,
  mergeQuoteMarks,
  openHoldingRequests,
  parseQuoteKeys,
  parseTencentBody,
  priceFromYahooMeta,
  toTencentSymbol,
  toYahooSymbol,
} = require('./quotes');

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textRes(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text, 'latin1'),
  };
}

test('maps A/HK/US symbols onto Yahoo and Tencent codes', () => {
  assert.equal(toYahooSymbol('A', '600519'), '600519.SS');
  assert.equal(toYahooSymbol('A', '000001'), '000001.SZ');
  assert.equal(toYahooSymbol('A', '300750'), '300750.SZ');
  assert.equal(toYahooSymbol('A', '688981'), '688981.SS');
  assert.equal(toYahooSymbol('A', '430047'), '430047.BJ');
  assert.equal(toYahooSymbol('HK', '700'), '0700.HK');
  assert.equal(toYahooSymbol('HK', '00700'), '0700.HK');
  assert.equal(toYahooSymbol('HK', '09988'), '9988.HK');
  assert.equal(toYahooSymbol('US', 'aapl'), 'AAPL');
  assert.equal(toYahooSymbol('US', 'BRK.B'), 'BRK-B');

  assert.equal(toTencentSymbol('A', '600519'), 'sh600519');
  assert.equal(toTencentSymbol('A', '1'), 'sz000001');
  assert.equal(toTencentSymbol('A', '430047'), 'bj430047');
  assert.equal(toTencentSymbol('HK', '700'), 'hk00700');
  assert.equal(toTencentSymbol('US', 'AAPL'), 'usAAPL');
});

test('parseQuoteKeys normalizes, de-dupes, and caps at MAX_SYMBOLS', () => {
  const parsed = parseQuoteKeys({
    keys: ['A:1', 'a:000001', 'US:aapl', 'NOPE', 'HK:700'],
    items: [{ market: 'US', symbol: 'AAPL' }],
  });
  assert.deepEqual(parsed.map((r) => r.key), ['A:000001', 'US:AAPL', 'HK:00700']);
  assert.equal(parsed[0].yahoo, '000001.SZ');
  assert.equal(parsed[2].yahoo, '0700.HK');

  const many = parseQuoteKeys({
    keys: Array.from({ length: MAX_SYMBOLS + 5 }, (_, i) => `US:T${i}`),
  });
  assert.equal(many.length, MAX_SYMBOLS);
});

test('openHoldingRequests only includes qty > 0', () => {
  const requests = openHoldingRequests([
    {
      id: 'b1', market: 'A', symbol: '600519', side: 'buy',
      price: 10, qty: 100, tradedAt: 1, fee: 0, tax: 0, createdAt: 1,
    },
    {
      id: 's1', market: 'A', symbol: '600519', side: 'sell',
      price: 12, qty: 100, tradedAt: 2, fee: 0, tax: 0, createdAt: 2,
    },
    {
      id: 'b2', market: 'US', symbol: 'aapl', side: 'buy',
      price: 100, qty: 2, tradedAt: 3, fee: 0, tax: 0, createdAt: 3,
    },
  ]);
  assert.deepEqual(requests.map((r) => r.key), ['US:AAPL']);
});

test('mergeQuoteMarks writes successes and keeps previous marks on failure', () => {
  const merged = mergeQuoteMarks(
    { 'A:600519': 1200, 'US:AAPL': 100, 'NOPE': 1 },
    { 'A:600519': 1257.05, 'HK:00700': 434, 'US:AAPL': 0 },
  );
  assert.equal(merged['A:600519'], 1257.05);
  assert.equal(merged['US:AAPL'], 100);
  assert.equal(merged['HK:00700'], 434);
  assert.equal(merged.NOPE, undefined);
});

test('yahoo meta falls back to previous close when last price is missing', () => {
  assert.equal(priceFromYahooMeta({ regularMarketPrice: 10 }), 10);
  assert.equal(priceFromYahooMeta({ regularMarketPrice: null, previousClose: 9.5 }), 9.5);
  assert.equal(priceFromYahooMeta({ regularMarketPrice: 0, chartPreviousClose: 8 }), 8);
  assert.equal(priceFromYahooMeta({ regularMarketPrice: -1 }), null);
});

test('parses Tencent qt payload prices', () => {
  const parsed = parseTencentBody(
    'v_sh600519="1~name~600519~1257.05~1";v_hk00700="100~x~00700~434.200~1";v_sz999999="";',
  );
  assert.equal(parsed.sh600519, 1257.05);
  assert.equal(parsed.hk00700, 434.2);
  assert.equal(parsed.sz999999, undefined);
});

test('fetchQuotes uses Yahoo then Tencent fallback; partial failure keeps successes', async () => {
  const requests = parseQuoteKeys({ keys: ['US:AAPL', 'A:600519', 'US:ZZZZ'] });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('finance.yahoo.com')) {
      return jsonRes({
        spark: {
          result: [
            { symbol: 'AAPL', response: [{ meta: { regularMarketPrice: 331.34 } }] },
          ],
          error: null,
        },
      });
    }
    if (url.includes('qt.gtimg.cn')) {
      assert.match(url, /sh600519/);
      assert.match(url, /usZZZZ/);
      assert.doesNotMatch(url, /usAAPL/);
      return textRes('v_sh600519="1~x~600519~1257.05~";');
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await fetchQuotes(requests, { fetchImpl, now: 42 });
  assert.equal(result.updatedAt, 42);
  assert.equal(result.quotes['US:AAPL'], 331.34);
  assert.equal(result.quotes['A:600519'], 1257.05);
  assert.equal(result.quotes['US:ZZZZ'], undefined);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].key, 'US:ZZZZ');
  assert.equal(calls.length, 2);
});

test('fetchQuotes treats a Yahoo batch error as fallback, not a wipe', async () => {
  const requests = parseQuoteKeys({ keys: ['HK:00700'] });
  const fetchImpl = async (url) => {
    if (url.includes('yahoo')) {
      const err = new Error('blocked');
      throw err;
    }
    return textRes('v_hk00700="100~x~00700~434.000~";');
  };
  const result = await fetchQuotes(requests, { fetchImpl });
  assert.equal(result.quotes['HK:00700'], 434);
  assert.deepEqual(result.failed, []);
});
