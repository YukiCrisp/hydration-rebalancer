#!/usr/bin/env node
// hydration-rebalancer: plan an equal-weight collateral rebalance on Hydration's
// money market and print ONE utility.batchAll call to sign elsewhere (Ledger).
// Never holds keys, never submits.
import { parseArgs } from 'node:util';
import BigNumber from 'bignumber.js';
import { connect, loadMarket, resolveAccount } from './core/chain.js';
import { batch, dryRun, quotePlan, type ChunkCall } from './core/build.js';
import {
  capLegs,
  healthFactor,
  maxDriftPp,
  planLegs,
  valueUsd,
  weights,
  type Position,
} from './core/plan.js';

// tBTC, ETH, HYPE: the reserves that are routable aToken<->aToken today.
const DEFAULT_ASSETS = '1000765,34,1001355';

const HELP = `Usage: hydration-rebalancer --address <ss58|0x…> [options]

  --address      Account to rebalance (SS58 or its H160). Read-only.
  --assets       Reserve asset ids to equal-weight (default ${DEFAULT_ASSETS} = tBTC,ETH,HYPE)
  --threshold    Rebalance only if some weight is off by more than N percentage points (default 5)
  --min-hf       Refuse if HF after any withdraw step falls below this (default 1.5)
  --slippage     Max extra input per buy, % (default 1)
  --max-chunks   Max chunks per leg when HF needs splitting (default 5)
  --min-leg      Skip legs smaller than this many USD (default 5)
  --max-usd      Cap the total USD moved this run, e.g. 20 for a first test (default: no cap)
  --max-impact   Refuse a buy whose quote is this % worse than the oracle (default 3)
  --force        Plan even when drift is below the threshold
  --rpc          Hydration RPC (default wss://rpc.hydradx.cloud)
`;

const fmtUsd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const fmtHf = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : '∞');

/** How much worse the quoted input is than an oracle-priced swap, in %. */
function impactPct(c: ChunkCall, byReserve: Map<number, Position>): number {
  const from = byReserve.get(c.leg.from)!;
  const to = byReserve.get(c.leg.to)!;
  const oracleIn = (c.amountOut.toNumber() * to.priceUsd) / from.priceUsd;
  return (c.amountIn.toNumber() / oracleIn - 1) * 100;
}

async function main() {
  const { values } = parseArgs({
    options: {
      address: { type: 'string' },
      assets: { type: 'string', default: DEFAULT_ASSETS },
      threshold: { type: 'string', default: '5' },
      'min-hf': { type: 'string', default: '1.5' },
      slippage: { type: 'string', default: '1' },
      'max-chunks': { type: 'string', default: '5' },
      'min-leg': { type: 'string', default: '5' },
      'max-usd': { type: 'string' },
      'max-impact': { type: 'string', default: '3' },
      force: { type: 'boolean', default: false },
      rpc: { type: 'string', default: 'wss://rpc.hydradx.cloud' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || !values.address) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  const assetIds = values.assets!.split(',').map((s) => Number(s.trim()));
  const threshold = Number(values.threshold);
  const minHf = Number(values['min-hf']);
  const slippagePct = Number(values.slippage);
  const maxChunks = Number(values['max-chunks']);
  const minLegUsd = Number(values['min-leg']);
  const maxUsd = values['max-usd'] ? Number(values['max-usd']) : Infinity;
  const maxImpactPct = Number(values['max-impact']);

  const chain = await connect(values.rpc!);
  try {
    const who = await resolveAccount(chain.api, values.address);
    console.log(`Account   ${who.ss58}\nEVM addr  ${who.evm}\n`);

    const { account, chainHf } = await loadMarket(chain, who);
    const byReserve = new Map(account.positions.map((p) => [p.reserveId, p]));
    const targets: Position[] = [];
    for (const id of assetIds) {
      const p = byReserve.get(id);
      if (!p || p.balance.isZero()) throw new Error(`no supplied position for reserve ${id}`);
      if (!p.isCollateral) throw new Error(`${p.symbol} (${id}) is supplied but not enabled as collateral`);
      targets.push(p);
    }

    const w = weights(targets);
    const total = targets.reduce((s, p) => s + valueUsd(p), 0);
    console.log('Collateral (target set)');
    for (const p of targets) {
      console.log(
        `  ${p.symbol.padEnd(6)} id ${String(p.reserveId).padEnd(8)} ${p.balance.toFixed(6).padStart(18)}` +
          `  @ ${fmtUsd(p.priceUsd).padStart(12)}  = ${fmtUsd(valueUsd(p)).padStart(12)}` +
          `  ${(w.get(p.reserveId)! * 100).toFixed(2).padStart(6)}%  LT ${p.liqThreshold}`,
      );
    }
    const others = account.positions.filter((p) => p.isCollateral && !assetIds.includes(p.reserveId));
    if (others.length) {
      console.log(`  (other collateral, untouched: ${others.map((p) => `${p.symbol} ${fmtUsd(valueUsd(p))}`).join(', ')})`);
    }
    const coll = new Map(
      account.positions.filter((p) => p.isCollateral).map((p) => [p.reserveId, { usd: valueUsd(p), lt: p.liqThreshold }]),
    );
    console.log(`  total ${fmtUsd(total)}   debt ${fmtUsd(account.debtUsd)}`);
    console.log(`  HF ${fmtHf(chainHf)} (chain)  ${fmtHf(healthFactor(coll, account.debtUsd))} (model)\n`);

    const drift = maxDriftPp(targets);
    console.log(`Max drift ${drift.toFixed(2)} pp (threshold ${threshold} pp)`);
    if (drift <= threshold && !values.force) {
      console.log('Within threshold — nothing to do.');
      return;
    }

    const legs = capLegs(planLegs(targets, minLegUsd), maxUsd, (id) => byReserve.get(id)!.decimals);
    if (!legs.length) {
      console.log('No leg above --min-leg — nothing to do.');
      return;
    }
    if (Number.isFinite(maxUsd)) console.log(`Capped to ${fmtUsd(maxUsd)} moved this run (--max-usd)`);
    const { calls, hfs } = await quotePlan(chain, account, legs, byReserve, { minHf, slippagePct, maxChunks });

    console.log('\nPlan (one utility.batchAll, executed in order)');
    calls.forEach((c, n) => {
      const from = byReserve.get(c.leg.from)!;
      const to = byReserve.get(c.leg.to)!;
      const premium = impactPct(c, byReserve);
      console.log(
        `  ${n + 1}. router.buy ${c.amountOut.toFixed()} a${to.symbol} with ≤ ${c.maxAmountIn.toFixed()} a${from.symbol}` +
          ` (quote ${c.amountIn.toFixed()}, ${premium >= 0 ? '+' : ''}${premium.toFixed(2)}% vs oracle)` +
          `\n     route ${c.route}` +
          `\n     HF after withdraw ${fmtHf(hfs[n].hfAfterWithdraw)}, after supply ${fmtHf(hfs[n].hfAfterSupply)}`,
      );
    });
    const worst = Math.min(...hfs.map((h) => h.hfAfterWithdraw));
    if (worst < minHf) {
      throw new Error(`quoted plan drops HF to ${fmtHf(worst)} < ${minHf}; raise --max-chunks, use --max-usd, or repay first`);
    }
    const worstImpact = Math.max(...calls.map((c) => impactPct(c, byReserve)));
    if (worstImpact > maxImpactPct) {
      throw new Error(
        `a buy is ${worstImpact.toFixed(2)}% worse than the oracle (> --max-impact ${maxImpactPct}); ` +
          'pool liquidity is too thin for this size — use --max-usd and rebalance in several runs',
      );
    }

    const tx = batch(chain.api, calls);
    const sim = await dryRun(chain.api, who, tx);
    console.log(`\nRuntime dry-run: ${sim.ok ? 'OK' : `FAILED — ${sim.error}`}`);
    if (!sim.ok) process.exitCode = 2;

    const info = await tx.paymentInfo(who.ss58).catch(() => null);
    if (info) console.log(`Estimated fee: ${new BigNumber(info.partialFee.toString()).shiftedBy(-12).toFixed(4)} HDX (or equivalent in your fee currency)`);
    console.log(`\nEncoded call (${tx.method.encodedLength} bytes) — polkadot.js apps → Developer → Extrinsics → Decode:`);
    console.log(tx.method.toHex());
    console.log(`\nCall hash: ${tx.method.hash.toHex()}`);
  } finally {
    await chain.close();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
