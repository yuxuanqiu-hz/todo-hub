'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computePositions,
  deleteAndValidate,
  formatQty,
  normalizeSymbol,
  sanitizeTrade,
  summarizeByCurrency,
  upsertAndValidate,
} = require('./trades');

function trade(partial) {
  return {
    id: partial.id || 't1',
    market: 'A',
    symbol: '600519',
    name: '贵州茅台',
    side: 'buy',
    price: 10,
    qty: 100,
    tradedAt: 1_000,
    fee: 0,
    tax: 0,
    createdAt: 1_000,
    ...partial,
  };
}

test('normalizes A/HK/US symbols', () => {
  assert.equal(normalizeSymbol('A', '600519'), '600519');
  assert.equal(normalizeSymbol('A', '1'), '000001');
  assert.equal(normalizeSymbol('HK', '700'), '00700');
  assert.equal(normalizeSymbol('HK', '00700'), '00700');
  assert.equal(normalizeSymbol('US', 'aapl'), 'AAPL');
});

test('moving-average cost includes buy fees; sell realizes against avg cost minus sell fees', () => {
  const trades = [
    trade({ id: 'b1', price: 10, qty: 100, fee: 10, tradedAt: 1 }),
    trade({ id: 'b2', price: 12, qty: 100, fee: 10, tradedAt: 2 }),
    trade({ id: 's1', side: 'sell', price: 13, qty: 50, fee: 5, tradedAt: 3 }),
  ];
  const { positions, errors } = computePositions(trades);
  assert.deepEqual(errors, []);
  assert.equal(positions.length, 1);
  const pos = positions[0];
  assert.equal(pos.qty, 150);
  assert.equal(pos.avgCost, 11.1);
  assert.equal(pos.totalCost, 1665);
  assert.equal(pos.realizedPnl, 90);
});

test('sell cannot exceed holdings at that time', () => {
  const existing = [trade({ id: 'b1', qty: 100, tradedAt: 1 })];
  const oversell = upsertAndValidate(existing, trade({ id: 's1', side: 'sell', qty: 120, tradedAt: 2 }));
  assert.equal(oversell.ok, false);
  assert.match(oversell.error, /卖出数量超过持仓/);
  assert.match(oversell.error, /120/);
  assert.match(oversell.error, /100/);
});

test('full close leaves zero qty and keeps realized pnl', () => {
  const trades = [
    trade({ id: 'b1', price: 10, qty: 100, fee: 5, tradedAt: 1 }),
    trade({ id: 's1', side: 'sell', price: 12, qty: 100, fee: 3, tax: 2, tradedAt: 2 }),
  ];
  const { positions, errors } = computePositions(trades);
  assert.deepEqual(errors, []);
  const pos = positions[0];
  assert.equal(pos.qty, 0);
  assert.equal(pos.totalCost, 0);
  assert.equal(pos.realizedPnl, 190);
});

test('markets and currencies stay separate', () => {
  const trades = [
    trade({ id: 'a1', market: 'A', symbol: '600519', qty: 10, price: 100, fee: 1 }),
    trade({ id: 'h1', market: 'HK', symbol: '700', name: '腾讯', qty: 100, price: 300, fee: 20 }),
    trade({ id: 'u1', market: 'US', symbol: 'AAPL', name: 'Apple', qty: 2, price: 180, fee: 1 }),
  ];
  const { positions } = computePositions(trades, { 'A:600519': 110, 'US:AAPL': 200 });
  assert.equal(positions.length, 3);
  const byMkt = Object.fromEntries(positions.map((p) => [p.market, p]));
  assert.equal(byMkt.A.currency, 'CNY');
  assert.equal(byMkt.HK.currency, 'HKD');
  assert.equal(byMkt.HK.symbol, '00700');
  assert.equal(byMkt.US.currency, 'USD');
  assert.equal(byMkt.A.unrealizedPnl, 99);
  assert.equal(byMkt.HK.unrealizedPnl, null);

  const sums = summarizeByCurrency(positions);
  assert.equal(sums.CNY.openCost, 1001);
  assert.equal(sums.HKD.openCost, 30020);
  assert.equal(sums.USD.openCost, 361);
  assert.equal(sums.CNY.hasUnrealized, true);
  assert.equal(sums.HKD.missingMarks, true);
});

test('editing a buy down that would strand a later sell is rejected', () => {
  const existing = [
    trade({ id: 'b1', qty: 100, tradedAt: 1 }),
    trade({ id: 's1', side: 'sell', qty: 80, tradedAt: 2 }),
  ];
  const edited = upsertAndValidate(existing, trade({ id: 'b1', qty: 50, tradedAt: 1 }));
  assert.equal(edited.ok, false);
  assert.match(edited.error, /卖出数量超过持仓/);
});

test('deleting a buy under a later sell is rejected with a clear message', () => {
  const existing = [
    trade({ id: 'b1', qty: 100, tradedAt: 1 }),
    trade({ id: 's1', side: 'sell', qty: 40, tradedAt: 2 }),
  ];
  const removed = deleteAndValidate(existing, 'b1');
  assert.equal(removed.ok, false);
  assert.match(removed.error, /删除后持仓将变为负数/);
});

test('sanitizeTrade rejects bad fields', () => {
  assert.equal(sanitizeTrade({}).error, '市场必须是 A股、港股或美股');
  assert.equal(sanitizeTrade(trade({ symbol: ' ' })).error, '请填写股票代码');
  assert.equal(sanitizeTrade(trade({ side: 'hold' })).error, '方向必须是买入或卖出');
  assert.equal(sanitizeTrade(trade({ price: 0 })).error, '成交价必须大于 0');
  assert.equal(sanitizeTrade(trade({ qty: -1 })).error, '数量必须大于 0');
  assert.equal(sanitizeTrade(trade({ fee: -1 })).error, '手续费不能为负数');
  assert.equal(sanitizeTrade(trade({ id: '' })).error, 'missing id');
});

test('formatQty drops trailing zeros', () => {
  assert.equal(formatQty(100), '100');
  assert.equal(formatQty(1.5), '1.5');
  assert.equal(formatQty(0), '0');
});
