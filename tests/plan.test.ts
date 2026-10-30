import { describe, expect, it } from 'vitest';
import BigNumber from 'bignumber.js';
import {
  applyTrades,
  capLegs,
  fitToBalances,
  planLegsTo,
  risk,
  chooseChunks,
  maxDriftPp,
  planLegs,
  simulateSteps,
  splitAmount,
  valueUsd,
  type Account,
  type Position,
} from '../src/core/plan.js';

const pos = (reserveId: number, usd: number, priceUsd: number, lt = 0.8): Position => ({
  reserveId,
  aTokenId: reserveId + 1,
  symbol: `A${reserveId}`,
  decimals: 18,
  balance: new BigNumber(usd / priceUsd),
  priceUsd,
  liqThreshold: lt,
  ltv: lt - 0.05,
  isCollateral: true,
});

describe('planLegs', () => {
  it('13K/10K/10K -> 11K each: one overweight funds two underweights', () => {
    const btc = pos(1, 13_000, 100_000);
    const eth = pos(2, 10_000, 4_000);
    const hype = pos(3, 10_000, 40);
    const legs = planLegs([btc, eth, hype]);
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.from === 1)).toBe(true);
    expect(legs.map((l) => l.usd)).toEqual([1_000, 1_000].map((x) => expect.closeTo(x, 6)));
    const toEth = legs.find((l) => l.to === 2)!;
    expect(toEth.amountOut.toNumber()).toBeCloseTo(0.25, 10); // $1000 / $4000
  });

  it('two overweights into one underweight', () => {
    const legs = planLegs([pos(1, 12_000, 1), pos(2, 12_000, 1), pos(3, 6_000, 1)]);
    expect(legs.map((l) => [l.from, l.to])).toEqual([
      [1, 3],
      [2, 3],
    ]);
    expect(legs.reduce((s, l) => s + l.usd, 0)).toBeCloseTo(4_000, 6);
  });

  it('balanced portfolio yields no legs and zero drift', () => {
    const ps = [pos(1, 100, 1), pos(2, 100, 2), pos(3, 100, 3)];
    expect(planLegs(ps)).toEqual([]);
    expect(maxDriftPp(ps)).toBeCloseTo(0, 9);
  });

  it('drift is in percentage points from equal weight', () => {
    expect(maxDriftPp([pos(1, 13_000, 1), pos(2, 10_000, 1), pos(3, 10_000, 1)])).toBeCloseTo(6.06, 2);
  });
});

describe('health factor simulation', () => {
  const account = (debtUsd: number): Account => ({
    positions: [pos(1, 13_000, 1, 0.85), pos(2, 10_000, 1, 0.85), pos(3, 10_000, 1, 0.75)],
    debtUsd,
  });

  it('reports the dip after the withdraw and the recovery after the supply', () => {
    const [h] = simulateSteps(account(15_000), [{ from: 1, to: 3, withdrawUsd: 2_000, supplyUsd: 2_000 }]);
    const before = (13_000 * 0.85 + 10_000 * 0.85 + 10_000 * 0.75) / 15_000;
    expect(h.hfAfterWithdraw).toBeCloseTo(before - (2_000 * 0.85) / 15_000, 9);
    expect(h.hfAfterSupply).toBeCloseTo(before - (2_000 * 0.1) / 15_000, 9); // LT 0.85 -> 0.75
  });

  it('chunks a leg until each withdraw keeps HF above the margin', () => {
    const acct = account(15_000); // HF ~1.80
    const legs = planLegs(acct.positions); // 13K/10K/10K -> moves $2K total
    const big = [{ ...legs[0], usd: 6_000 }]; // HF after one-shot withdraw ~1.46
    expect(chooseChunks(acct, big, { minHf: 1.5, slippagePct: 1, maxChunks: 5 })).toEqual([2]);
  });

  it('refuses when no chunking keeps HF safe', () => {
    const acct = account(20_000); // HF ~1.35 already
    const legs = planLegs(acct.positions);
    expect(() => chooseChunks(acct, legs, { minHf: 1.5, slippagePct: 1, maxChunks: 5 })).toThrow(/drops HF/);
  });

  it('never models a debt change', () => {
    const acct = account(15_000);
    simulateSteps(acct, [{ from: 1, to: 2, withdrawUsd: 1_000, supplyUsd: 1_000 }]);
    expect(acct.debtUsd).toBe(15_000);
    expect(valueUsd(acct.positions[0])).toBeCloseTo(13_000, 6); // input untouched
  });
});

describe('amount helpers', () => {
  it('splitAmount sums exactly to the original', () => {
    const a = new BigNumber('1.000000000000000001');
    const parts = splitAmount(a, 3, 18);
    expect(parts.reduce((s, p) => s.plus(p), new BigNumber(0)).eq(a)).toBe(true);
  });

  it('capLegs scales every leg proportionally', () => {
    const legs = planLegs([pos(1, 13_000, 1), pos(2, 10_000, 1), pos(3, 10_000, 1)]);
    const capped = capLegs(legs, 20, () => 18);
    expect(capped.reduce((s, l) => s + l.usd, 0)).toBeCloseTo(20, 9);
    expect(capped[0].amountOut.toNumber()).toBeCloseTo(10, 9);
  });
});

describe('custom target weights', () => {
  it('50/30/20 targets from an equal start', () => {
    const ps = [pos(1, 100, 1), pos(2, 100, 1), pos(3, 100, 1)];
    const legs = planLegsTo(ps, new Map([[1, 50], [2, 30], [3, 20]]));
    // 1 needs +50, 2 needs -10, 3 needs -40
    expect(legs.map((l) => [l.from, l.to, Math.round(l.usd)])).toEqual([
      [3, 1, 40],
      [2, 1, 10],
    ]);
  });

  it('a zero weight sells the whole asset, kept inside balance + slippage', () => {
    const ps = [pos(1, 100, 1), pos(2, 100, 1)];
    const legs = fitToBalances(planLegsTo(ps, new Map([[1, 1], [2, 0]])), ps, 1);
    expect(legs).toHaveLength(1);
    expect(legs[0].usd * 1.01).toBeLessThanOrEqual(100);
    expect(legs[0].usd).toBeGreaterThan(98);
  });

  it('can target an asset the account does not hold yet', () => {
    const fresh = { ...pos(3, 0, 10), isCollateral: false };
    const legs = planLegsTo([pos(1, 100, 1), pos(2, 100, 1), fresh], new Map([[1, 1], [2, 1], [3, 1]]));
    expect(legs.every((l) => l.to === 3)).toBe(true);
    expect(legs.reduce((s, l) => s + l.usd, 0)).toBeCloseTo(66.67, 1);
  });
});

describe('risk', () => {
  it('weighted LT, uniform drop and single-asset drop to liquidation', () => {
    const ps = [pos(1, 13_000, 1, 0.85), pos(2, 10_000, 1, 0.85), pos(3, 10_000, 1, 0.75)];
    const r = risk(ps, 15_000);
    expect(r.avgLt).toBeCloseTo(27_050 / 33_000, 9);
    expect(r.hf).toBeCloseTo(27_050 / 15_000, 9);
    expect(r.uniformDropToLiq).toBeCloseTo(1 - 15_000 / 27_050, 9);
    // asset 1 alone would have to lose (27050 - 15000) / (13000 * .85) > 100%: cannot liquidate alone
    expect(r.assetDropToLiq.get(1)).toBeNull();
    // with more debt it can: (27050 - 20000) / 11050
    expect(risk(ps, 20_000).assetDropToLiq.get(1)).toBeCloseTo(7_050 / 11_050, 9);
  });

  it('applyTrades moves balances and enables collateral on first supply', () => {
    const fresh = { ...pos(3, 0, 10), isCollateral: false };
    const after = applyTrades([pos(1, 100, 1), fresh], [
      { from: 1, to: 3, amountIn: new BigNumber(30), amountOut: new BigNumber(2.9) },
    ]);
    expect(after[0].balance.toNumber()).toBeCloseTo(70, 9);
    expect(after[1].balance.toNumber()).toBeCloseTo(2.9, 9);
    expect(after[1].isCollateral).toBe(true);
  });
});
