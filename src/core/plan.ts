// Pure planning logic: no chain access. Everything here is in USD (number) or
// token units (BigNumber, human decimals) so it can be unit-tested offline.
import BigNumber from 'bignumber.js';

export interface Position {
  reserveId: number;      // underlying asset id (e.g. 1000765 tBTC)
  aTokenId: number;       // aToken asset id (e.g. 1006 atBTC)
  symbol: string;
  decimals: number;
  balance: BigNumber;     // aToken balance, human units
  priceUsd: number;       // Aave oracle price
  liqThreshold: number;   // reserve liquidation threshold, 0..1
  ltv: number;            // reserve max LTV, 0..1 (borrow limit only, not HF)
  isCollateral: boolean;  // enabled as collateral for this user
}

export interface Account {
  positions: Position[];  // every collateral reserve the user holds, not only the target set
  debtUsd: number;
}

export interface Leg {
  from: number;           // reserveId sold (overweight)
  to: number;             // reserveId bought (underweight)
  usd: number;            // value moved
  amountOut: BigNumber;   // exact amount of `to` bought (human units)
}

export interface Step {
  from: number;
  to: number;
  withdrawUsd: number;    // worst case: includes slippage allowance
  supplyUsd: number;
}

export interface StepHf {
  hfAfterWithdraw: number;
  hfAfterSupply: number;
}

export const valueUsd = (p: Position) => p.balance.toNumber() * p.priceUsd;

export function weights(positions: Position[]): Map<number, number> {
  const total = positions.reduce((s, p) => s + valueUsd(p), 0);
  return new Map(positions.map((p) => [p.reserveId, total > 0 ? valueUsd(p) / total : 0]));
}

/** Largest absolute weight deviation from equal weight, in percentage points. */
export function maxDriftPp(positions: Position[]): number {
  const target = 1 / positions.length;
  let max = 0;
  for (const w of weights(positions).values()) max = Math.max(max, Math.abs(w - target) * 100);
  return max;
}

/** Equal weights over the given positions. */
export function equalWeights(positions: Position[]): Map<number, number> {
  return new Map(positions.map((p) => [p.reserveId, 1 / positions.length]));
}

/**
 * Greedy matching of surpluses to deficits against target weights (any scale;
 * they are normalized). The largest overweight asset funds the largest
 * underweight one until both sides are within `minLegUsd`.
 */
export function planLegsTo(positions: Position[], target: Map<number, number>, minLegUsd = 1): Leg[] {
  const total = positions.reduce((s, p) => s + valueUsd(p), 0);
  const wSum = positions.reduce((s, p) => s + (target.get(p.reserveId) ?? 0), 0);
  if (wSum <= 0) throw new Error('target weights sum to zero');
  const surplus = positions.map((p) => ({ p, d: valueUsd(p) - (total * (target.get(p.reserveId) ?? 0)) / wSum }));
  const over = surplus.filter((x) => x.d > minLegUsd).sort((a, b) => b.d - a.d);
  const under = surplus.filter((x) => x.d < -minLegUsd).sort((a, b) => a.d - b.d);

  const legs: Leg[] = [];
  let i = 0;
  let j = 0;
  while (i < over.length && j < under.length) {
    const usd = Math.min(over[i].d, -under[j].d);
    if (usd >= minLegUsd) {
      const to = under[j].p;
      legs.push({
        from: over[i].p.reserveId,
        to: to.reserveId,
        usd,
        amountOut: new BigNumber(usd / to.priceUsd).decimalPlaces(to.decimals, BigNumber.ROUND_DOWN),
      });
    }
    over[i].d -= usd;
    under[j].d += usd;
    if (over[i].d <= minLegUsd) i++;
    if (-under[j].d <= minLegUsd) j++;
  }
  return legs;
}

export const planLegs = (targets: Position[], minLegUsd = 1) => planLegsTo(targets, equalWeights(targets), minLegUsd);

/**
 * Scale down legs that would spend more of an asset than the account holds
 * once slippage is allowed for (max_amount_in must fit the balance). Matters
 * when a target weight is 0, i.e. "sell all of this": a little dust remains.
 */
export function fitToBalances(legs: Leg[], positions: Position[], slippagePct: number): Leg[] {
  const byId = new Map(positions.map((p) => [p.reserveId, p]));
  const spend = new Map<number, number>();
  for (const l of legs) spend.set(l.from, (spend.get(l.from) ?? 0) + l.usd);
  return legs.map((l) => {
    const p = byId.get(l.from)!;
    const room = (valueUsd(p) * 0.999) / (1 + slippagePct / 100);
    const f = Math.min(1, room / spend.get(l.from)!);
    if (f >= 1) return l;
    const to = byId.get(l.to)!;
    return { ...l, usd: l.usd * f, amountOut: l.amountOut.times(f).decimalPlaces(to.decimals, BigNumber.ROUND_DOWN) };
  });
}

export function healthFactor(collateral: Map<number, { usd: number; lt: number; counts?: boolean }>, debtUsd: number): number {
  if (debtUsd <= 0) return Infinity;
  let weighted = 0;
  for (const { usd, lt, counts } of collateral.values()) if (counts !== false) weighted += usd * lt;
  return weighted / debtUsd;
}

// A supplied reserve counts toward HF when it is enabled as collateral, or when
// the account holds none of it yet (Aave enables collateral on the first supply).
function collateralMap(account: Account) {
  return new Map(
    account.positions.map((p) => [
      p.reserveId,
      { usd: valueUsd(p), lt: p.liqThreshold, counts: p.isCollateral || (p.balance.isZero() && p.ltv > 0) },
    ]),
  );
}

/**
 * Walk the steps in order and report HF right after the withdraw half and
 * after the supply half of each. Inside one router call Aave checks HF at the
 * withdraw, so `hfAfterWithdraw` is the number that must stay safe.
 */
export function simulateSteps(account: Account, steps: Step[]): StepHf[] {
  const coll = collateralMap(account);
  const out: StepHf[] = [];
  for (const s of steps) {
    const from = coll.get(s.from);
    const to = coll.get(s.to);
    if (!from || !to) throw new Error(`reserve ${s.from}/${s.to} is not in the market`);
    from.usd -= s.withdrawUsd;
    if (from.usd < -1e-6) throw new Error(`step withdraws more than the ${s.from} position`);
    const hfAfterWithdraw = healthFactor(coll, account.debtUsd);
    to.usd += s.supplyUsd;
    out.push({ hfAfterWithdraw, hfAfterSupply: healthFactor(coll, account.debtUsd) });
  }
  return out;
}

/** Split one leg into `k` equal steps (worst-case withdraw includes slippage). */
export function legSteps(leg: Leg, k: number, slippagePct: number): Step[] {
  const usd = leg.usd / k;
  return Array.from({ length: k }, () => ({
    from: leg.from,
    to: leg.to,
    withdrawUsd: usd * (1 + slippagePct / 100),
    supplyUsd: usd,
  }));
}

/**
 * Choose the smallest chunk count per leg so that HF after every withdraw
 * stays >= minHf. Legs are chunked independently but simulated in sequence.
 * Throws when even `maxChunks` cannot keep HF above the margin.
 */
export function chooseChunks(
  account: Account,
  legs: Leg[],
  opts: { minHf: number; slippagePct: number; maxChunks: number },
): number[] {
  const chunks: number[] = [];
  for (let i = 0; i < legs.length; i++) {
    let ok = false;
    for (let k = 1; k <= opts.maxChunks; k++) {
      const steps = [
        ...legs.slice(0, i).flatMap((l, n) => legSteps(l, chunks[n], opts.slippagePct)),
        ...legSteps(legs[i], k, opts.slippagePct),
      ];
      const hfs = simulateSteps(account, steps);
      if (hfs.every((h) => h.hfAfterWithdraw >= opts.minHf)) {
        chunks.push(k);
        ok = true;
        break;
      }
    }
    if (!ok) {
      throw new Error(
        `leg ${legs[i].from}->${legs[i].to} ($${legs[i].usd.toFixed(2)}) drops HF below ${opts.minHf} ` +
          `even in ${opts.maxChunks} chunks; repay some debt first or lower --min-hf`,
      );
    }
  }
  return chunks;
}

/** Split amountOut into k parts that sum exactly to the original (last part takes the rounding rest). */
export function splitAmount(amount: BigNumber, k: number, decimals: number): BigNumber[] {
  const part = amount.div(k).decimalPlaces(decimals, BigNumber.ROUND_DOWN);
  const parts = Array.from({ length: k - 1 }, () => part);
  parts.push(amount.minus(part.times(k - 1)));
  return parts;
}

/** Scale all legs down so they move at most `maxUsd` in total (for small test runs). */
export function capLegs(legs: Leg[], maxUsd: number, decimalsOf: (reserveId: number) => number): Leg[] {
  const total = legs.reduce((s, l) => s + l.usd, 0);
  if (total <= maxUsd) return legs;
  const f = maxUsd / total;
  return legs.map((l) => ({
    ...l,
    usd: l.usd * f,
    amountOut: l.amountOut.times(f).decimalPlaces(decimalsOf(l.to), BigNumber.ROUND_DOWN),
  }));
}

export interface Risk {
  collateralUsd: number;
  debtUsd: number;
  hf: number;
  avgLt: number;            // value-weighted liquidation threshold
  avgLtv: number;           // value-weighted max LTV
  borrowLimitUsd: number;   // collateral x LTV
  utilization: number;      // debt / borrow limit
  uniformDropToLiq: number | null;            // all collateral prices fall together by this fraction -> HF 1
  assetDropToLiq: Map<number, number | null>; // only this asset falls; null = cannot liquidate alone
}

/**
 * Risk numbers for a set of collateral positions against stablecoin debt
 * (debt value is held constant when prices move).
 */
export function risk(positions: Position[], debtUsd: number): Risk {
  const coll = positions.filter((p) => p.isCollateral);
  const collateralUsd = coll.reduce((s, p) => s + valueUsd(p), 0);
  const weighted = coll.reduce((s, p) => s + valueUsd(p) * p.liqThreshold, 0);
  const borrowLimitUsd = coll.reduce((s, p) => s + valueUsd(p) * p.ltv, 0);
  const hf = debtUsd > 0 ? weighted / debtUsd : Infinity;
  const assetDropToLiq = new Map<number, number | null>();
  for (const p of coll) {
    const v = valueUsd(p) * p.liqThreshold;
    const x = v > 0 && debtUsd > 0 ? (weighted - debtUsd) / v : null;
    assetDropToLiq.set(p.reserveId, x != null && x < 1 ? Math.max(0, x) : null);
  }
  return {
    collateralUsd,
    debtUsd,
    hf,
    avgLt: collateralUsd > 0 ? weighted / collateralUsd : 0,
    avgLtv: collateralUsd > 0 ? borrowLimitUsd / collateralUsd : 0,
    borrowLimitUsd,
    utilization: borrowLimitUsd > 0 ? debtUsd / borrowLimitUsd : 0,
    uniformDropToLiq: debtUsd > 0 ? Math.max(0, 1 - 1 / hf) : null,
    assetDropToLiq,
  };
}

/** Positions after trades: subtract what each trade spends, add what it buys (human units). */
export function applyTrades(
  positions: Position[],
  trades: { from: number; to: number; amountIn: BigNumber; amountOut: BigNumber }[],
): Position[] {
  const next = new Map(positions.map((p) => [p.reserveId, { ...p }]));
  for (const t of trades) {
    const f = next.get(t.from)!;
    const to = next.get(t.to)!;
    f.balance = BigNumber.max(0, f.balance.minus(t.amountIn));
    to.balance = to.balance.plus(t.amountOut);
    // Aave enables collateral on the first supply of a collateral-capable reserve
    if (to.ltv > 0) to.isCollateral = true;
  }
  return [...next.values()];
}
