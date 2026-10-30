// Checks a decoded batch before it goes to the wallet. The browser runs this on
// the call it decoded itself, so what is signed has to match the quote shown on
// screen, whatever the local server sent. Pure: no chain access.
import BigNumber from 'bignumber.js';
import type { Position } from './plan.js';

// Same value the Hydration SDK/UI adds for Aave-touching trades by borrowers.
export const AAVE_EXTRA_GAS = '1000000';
// oracle prices on the page were read a moment before the quote; allow that drift
const PRICE_MARGIN = 0.01;

export interface DecodedBuy {
  extraGas: string;
  assetIn: number;      // aToken asset ids
  assetOut: number;
  amountOut: string;    // raw units
  maxAmountIn: string;  // raw units
  route: { assetIn: number; assetOut: number }[];
}

export interface ExpectedBuy {
  from: number;         // reserve ids, as quoted
  to: number;
  amountOut: string;    // human units
  maxAmountIn: string;
}

export interface VerifiedBuy {
  from: Position;
  to: Position;
  amountOut: BigNumber; // human units
  maxAmountIn: BigNumber;
  worstVsOraclePct: number; // paying max_amount_in, compared with the oracle price
}

export interface VerifyLimits {
  slippagePct: number;
  maxImpactPct: number;
}

/** The part of a decoded polkadot.js Call this file reads. */
export interface CallLike {
  section: string;
  method: string;
  args: any[];
}

const num = (codec: { toString(): string }) => Number(codec.toString());

/**
 * Pulls the router.buy arguments out of a decoded call, refusing anything that is
 * not utility.batchAll([dispatcher.dispatchWithExtraGas(router.buy), ...]).
 */
export function decodeBatch(call: CallLike): DecodedBuy[] {
  if (call.section !== 'utility' || call.method !== 'batchAll') {
    throw new Error(`外側が utility.batchAll ではありません（${call.section}.${call.method}）`);
  }
  return (call.args[0] as CallLike[]).map((wrap, i) => {
    const n = i + 1;
    if (wrap.section !== 'dispatcher' || wrap.method !== 'dispatchWithExtraGas') {
      throw new Error(`${n} 件目が dispatcher.dispatchWithExtraGas ではありません（${wrap.section}.${wrap.method}）`);
    }
    const [buy, extraGas] = wrap.args as [CallLike, { toString(): string }];
    if (buy.section !== 'router' || buy.method !== 'buy') {
      throw new Error(`${n} 件目の中身が router.buy ではありません（${buy.section}.${buy.method}）`);
    }
    const [assetIn, assetOut, amountOut, maxAmountIn, route] = buy.args;
    return {
      extraGas: extraGas.toString(),
      assetIn: num(assetIn),
      assetOut: num(assetOut),
      amountOut: amountOut.toString(),
      maxAmountIn: maxAmountIn.toString(),
      route: [...route].map((t: any) => ({ assetIn: num(t.assetIn), assetOut: num(t.assetOut) })),
    };
  });
}

/**
 * Throws unless every entry is dispatcher.dispatchWithExtraGas(router.buy) between
 * two known aTokens, matches the quote row at the same index, has a route that
 * starts and ends at those aTokens, and caps the price within impact + slippage
 * of the oracle. The call structure is checked by decodeBatch.
 */
export function verifyBuys(
  buys: DecodedBuy[],
  expected: ExpectedBuy[],
  positions: Position[],
  limits: VerifyLimits,
): VerifiedBuy[] {
  if (!buys.length) throw new Error('call の中にスワップがありません');
  if (buys.length !== expected.length) {
    throw new Error(`call のスワップ数 ${buys.length} が見積もりの ${expected.length} と一致しません`);
  }
  const byAToken = new Map(positions.map((p) => [p.aTokenId, p]));
  const maxRatio = (1 + limits.maxImpactPct / 100) * (1 + limits.slippagePct / 100) * (1 + PRICE_MARGIN);

  return buys.map((b, i) => {
    const n = i + 1;
    const exp = expected[i];
    if (b.extraGas !== AAVE_EXTRA_GAS) throw new Error(`${n} 件目: extra gas ${b.extraGas} が想定と違います`);
    const from = byAToken.get(b.assetIn);
    const to = byAToken.get(b.assetOut);
    if (!from || !to) throw new Error(`${n} 件目: 知らない資産 ${b.assetIn} → ${b.assetOut} です`);
    if (from === to) throw new Error(`${n} 件目: 同じ資産どうしのスワップです`);
    if (from.reserveId !== exp.from || to.reserveId !== exp.to) {
      throw new Error(`${n} 件目: 資産が見積もり（${exp.from} → ${exp.to}）と違います`);
    }

    const amountOut = new BigNumber(b.amountOut).shiftedBy(-to.decimals);
    const maxAmountIn = new BigNumber(b.maxAmountIn).shiftedBy(-from.decimals);
    if (!amountOut.gt(0)) throw new Error(`${n} 件目: 受け取る量が 0 です`);
    if (!amountOut.eq(exp.amountOut)) throw new Error(`${n} 件目: 受け取る量が見積もりと違います`);
    if (!maxAmountIn.eq(exp.maxAmountIn)) throw new Error(`${n} 件目: 払う上限が見積もりと違います`);

    const r = b.route;
    if (!r.length || r[0].assetIn !== b.assetIn || r[r.length - 1].assetOut !== b.assetOut) {
      throw new Error(`${n} 件目: ルートの始点か終点が資産と一致しません`);
    }
    for (let k = 1; k < r.length; k++) {
      if (r[k].assetIn !== r[k - 1].assetOut) throw new Error(`${n} 件目: ルートがつながっていません`);
    }

    const oracleIn = amountOut.times(to.priceUsd).div(from.priceUsd);
    const ratio = maxAmountIn.div(oracleIn).toNumber();
    if (!(ratio <= maxRatio)) {
      throw new Error(
        `${n} 件目: 払う上限が oracle 価格より ${((ratio - 1) * 100).toFixed(2)}% 高く、許容（インパクト＋スリッページ）を超えています`,
      );
    }
    return { from, to, amountOut, maxAmountIn, worstVsOraclePct: (ratio - 1) * 100 };
  });
}
