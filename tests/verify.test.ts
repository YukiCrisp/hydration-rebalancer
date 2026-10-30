import { describe, expect, it } from 'vitest';
import BigNumber from 'bignumber.js';
import { decodeBatch, verifyBuys, type CallLike, type DecodedBuy, type ExpectedBuy } from '../src/core/verify.js';
import type { Position } from '../src/core/plan.js';

const pos = (reserveId: number, aTokenId: number, priceUsd: number, decimals: number): Position => ({
  reserveId,
  aTokenId,
  symbol: `R${reserveId}`,
  decimals,
  balance: new BigNumber(1_000),
  priceUsd,
  liqThreshold: 0.8,
  ltv: 0.75,
  isCollateral: true,
});

// tBTC (8 dp, $100K) -> HYPE (18 dp, $40)
const positions = [pos(1000765, 1006, 100_000, 8), pos(1001355, 1010, 40, 18)];
const limits = { slippagePct: 1, maxImpactPct: 3 };

// buy 250 aHYPE ($10K) with at most 0.101 atBTC: 1% over oracle
const goodBuy = (): DecodedBuy => ({
  extraGas: '1000000',
  assetIn: 1006,
  assetOut: 1010,
  amountOut: '250000000000000000000',
  maxAmountIn: '10100000',
  route: [
    { assetIn: 1006, assetOut: 1000765 },
    { assetIn: 1000765, assetOut: 1001355 },
    { assetIn: 1001355, assetOut: 1010 },
  ],
});
const expected: ExpectedBuy[] = [{ from: 1000765, to: 1001355, amountOut: '250', maxAmountIn: '0.101' }];

describe('verifyBuys', () => {
  it('accepts a buy that matches the quote', () => {
    const [v] = verifyBuys([goodBuy()], expected, positions, limits);
    expect(v.from.reserveId).toBe(1000765);
    expect(v.amountOut.toFixed()).toBe('250');
    expect(v.worstVsOraclePct).toBeCloseTo(1, 9);
  });

  it.each<[string, (b: DecodedBuy) => void, RegExp]>([
    ['amount out differs from the quote', (b) => (b.amountOut = '260000000000000000000'), /受け取る量/],
    ['max amount in differs from the quote', (b) => (b.maxAmountIn = '10200000'), /払う上限/],
    ['unknown asset', (b) => (b.assetOut = 5), /知らない資産/],
    ['wrong extra gas', (b) => (b.extraGas = '0'), /extra gas/],
    ['route ends elsewhere', (b) => (b.route[2].assetOut = 1007), /終点/],
    ['route has a gap', (b) => (b.route[1].assetIn = 34), /つながって/],
  ])('refuses: %s', (_name, mutate, msg) => {
    const b = goodBuy();
    mutate(b);
    expect(() => verifyBuys([b], expected, positions, limits)).toThrow(msg);
  });

  it('refuses a price cap beyond impact + slippage of the oracle', () => {
    const b = { ...goodBuy(), maxAmountIn: '11000000' }; // 10% over oracle
    expect(() => verifyBuys([b], [{ ...expected[0], maxAmountIn: '0.11' }], positions, limits)).toThrow(/oracle/);
  });

  it('refuses a different number of swaps than quoted', () => {
    expect(() => verifyBuys([goodBuy(), goodBuy()], expected, positions, limits)).toThrow(/スワップ数/);
  });
});

describe('decodeBatch', () => {
  const codec = (v: string | number) => ({ toString: () => String(v) });
  const buyCall = (section = 'router', method = 'buy'): CallLike => ({
    section,
    method,
    args: [codec(1006), codec(1010), codec('5'), codec('7'), [{ assetIn: codec(1006), assetOut: codec(1010) }]],
  });
  const wrap = (inner: CallLike, section = 'dispatcher', method = 'dispatchWithExtraGas'): CallLike => ({
    section,
    method,
    args: [inner, codec('1000000')],
  });

  it('extracts router.buy arguments', () => {
    const [b] = decodeBatch({ section: 'utility', method: 'batchAll', args: [[wrap(buyCall())]] });
    expect(b).toEqual({
      extraGas: '1000000',
      assetIn: 1006,
      assetOut: 1010,
      amountOut: '5',
      maxAmountIn: '7',
      route: [{ assetIn: 1006, assetOut: 1010 }],
    });
  });

  it('refuses anything that is not batchAll of wrapped router.buy', () => {
    expect(() => decodeBatch({ section: 'utility', method: 'batch', args: [[]] })).toThrow(/batchAll/);
    expect(() => decodeBatch({ section: 'utility', method: 'batchAll', args: [[buyCall()]] })).toThrow(/dispatchWithExtraGas/);
    expect(() =>
      decodeBatch({ section: 'utility', method: 'batchAll', args: [[wrap(buyCall('balances', 'transferKeepAlive'))]] }),
    ).toThrow(/router.buy/);
  });
});
