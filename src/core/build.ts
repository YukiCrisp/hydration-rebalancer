// Turn planned legs into router.buy calls and wrap them in one utility.batchAll.
//
// Each call buys the *aToken* of the underweight reserve with the *aToken* of
// the overweight one. The router's Aave pool type does Pool.withdraw on the
// way in and Pool.supply on the way out, all inside the user's own account,
// so one router.buy = withdraw -> swap -> supply. Debt is never touched.
import type { ApiPromise } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import { TradeRouteBuilder, type Trade } from '@galacticcouncil/sdk';
import BigNumber from 'bignumber.js';
import type { Chain, Who } from './chain.js';
import {
  chooseChunks,
  simulateSteps,
  splitAmount,
  type Account,
  type Leg,
  type Position,
  type Step,
  type StepHf,
} from './plan.js';

// Same value the Hydration SDK/UI adds for Aave-touching trades by borrowers.
const AAVE_EXTRA_GAS = 1_000_000n;
const DRY_RUN_XCM_VERSION = 4;

export interface ChunkCall {
  leg: Leg;
  index: number;          // chunk number within the leg
  amountOut: BigNumber;   // human units of `to`
  amountIn: BigNumber;    // quoted, human units of `from`
  maxAmountIn: BigNumber; // with slippage
  route: string;
  call: SubmittableExtrinsic<'promise'>;
  step: Step;             // for HF re-simulation with quoted amounts
}

const raw = (v: BigNumber, decimals: number) => v.shiftedBy(decimals).integerValue(BigNumber.ROUND_DOWN);

/**
 * Quote chunk i as quote(first i chunks) - quote(first i-1 chunks), so later
 * chunks are priced as if earlier ones already moved the pools. (Plain
 * per-chunk quotes would all see the same untouched pool state.)
 */
export async function buildLegCalls(
  chain: Chain,
  leg: Leg,
  chunks: number,
  byReserve: Map<number, Position>,
  slippagePct: number,
): Promise<ChunkCall[]> {
  const from = byReserve.get(leg.from)!;
  const to = byReserve.get(leg.to)!;
  const parts = splitAmount(leg.amountOut, chunks, to.decimals);
  const out: ChunkCall[] = [];
  let cumOut = new BigNumber(0);
  let prevIn = new BigNumber(0); // raw
  for (let i = 0; i < parts.length; i++) {
    cumOut = cumOut.plus(parts[i]);
    const trade: Trade = await chain.sdk.api.router.getBestBuy(
      String(from.aTokenId),
      String(to.aTokenId),
      cumOut.toFixed(),
    );
    const errors = trade.swaps.flatMap((s) => s.errors);
    if (errors.length) throw new Error(`route ${from.symbol}->${to.symbol} has errors: ${errors.join(', ')}`);
    const amountInRaw = trade.amountIn.minus(prevIn);
    prevIn = trade.amountIn;
    const maxInRaw = amountInRaw.times(1 + slippagePct / 100).integerValue(BigNumber.ROUND_UP);
    const amountOutRaw = raw(parts[i], to.decimals);
    const call = wrapForAave(
      chain.api,
      chain.api.tx.router.buy(
        from.aTokenId,
        to.aTokenId,
        amountOutRaw.toFixed(),
        maxInRaw.toFixed(),
        TradeRouteBuilder.build(trade.swaps) as any,
      ),
    );
    const amountIn = amountInRaw.shiftedBy(-from.decimals);
    const maxAmountIn = maxInRaw.shiftedBy(-from.decimals);
    out.push({
      leg,
      index: i,
      amountOut: parts[i],
      amountIn,
      maxAmountIn,
      route: trade.swaps.map((s) => `${s.pool}:${s.assetIn}>${s.assetOut}`).join(' '),
      call,
      step: {
        from: leg.from,
        to: leg.to,
        withdrawUsd: maxAmountIn.toNumber() * from.priceUsd,
        supplyUsd: parts[i].toNumber() * to.priceUsd,
      },
    });
  }
  return out;
}

export interface PlanOpts {
  minHf: number;
  slippagePct: number;
  maxChunks: number;
}

/**
 * Quote every leg into router.buy chunks. The oracle-based estimate gives the
 * starting chunk count; quotes can be worse (price impact), so each leg is
 * re-chunked until the quoted HF after every withdraw also clears minHf, or
 * maxChunks is reached (the caller checks the returned HFs).
 */
export async function quotePlan(
  chain: Chain,
  account: Account,
  legs: Leg[],
  byReserve: Map<number, Position>,
  opts: PlanOpts,
): Promise<{ calls: ChunkCall[]; hfs: StepHf[] }> {
  const chunks = chooseChunks(account, legs, opts);
  const calls: ChunkCall[] = [];
  let hfs: StepHf[] = [];
  for (let i = 0; i < legs.length; i++) {
    for (;;) {
      const legCalls = await buildLegCalls(chain, legs[i], chunks[i], byReserve, opts.slippagePct);
      hfs = simulateSteps(account, [...calls, ...legCalls].map((c) => c.step));
      if (hfs.every((h) => h.hfAfterWithdraw >= opts.minHf) || chunks[i] >= opts.maxChunks) {
        calls.push(...legCalls);
        break;
      }
      chunks[i]++;
    }
  }
  return { calls, hfs };
}

/** Borrowers' Aave calls run out of EVM gas without the dispatcher's extra gas. */
function wrapForAave(api: ApiPromise, call: SubmittableExtrinsic<'promise'>) {
  return api.tx.dispatcher.dispatchWithExtraGas(call, AAVE_EXTRA_GAS);
}

export function batch(api: ApiPromise, calls: ChunkCall[]) {
  return api.tx.utility.batchAll(calls.map((c) => c.call));
}

export interface DryRun {
  ok: boolean;
  error?: string;
  events: string[];
}

/** Execute the batch in the runtime's dryRunApi as the user's signed origin. Nothing is submitted. */
export async function dryRun(api: ApiPromise, who: Who, tx: SubmittableExtrinsic<'promise'>): Promise<DryRun> {
  const res: any = await (api.call as any).dryRunApi.dryRunCall(
    { system: { Signed: who.ss58 } },
    tx.method,
    DRY_RUN_XCM_VERSION,
  );
  if (res.isErr) return { ok: false, error: JSON.stringify(res.asErr.toHuman()), events: [] };
  const effects = res.asOk;
  const events: string[] = effects.emittedEvents.map((e: any) => `${e.section}.${e.method}`);
  const exec = effects.executionResult;
  if (exec.isErr) {
    const err = exec.asErr.error;
    let msg = JSON.stringify(err.toHuman());
    if (err.isModule) {
      const meta = api.registry.findMetaError(err.asModule);
      msg = `${meta.section}.${meta.name}: ${meta.docs.join(' ')}`;
    }
    return { ok: false, error: msg, events };
  }
  // batchAll is atomic, but a nested dispatcher call can still report EVM failure via events
  const failed = events.find((e) => /EvmCallFailed|BatchInterrupted/.test(e));
  return failed ? { ok: false, error: failed, events } : { ok: true, events };
}
