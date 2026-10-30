// Local-only web server for the rebalancer UI. Reads, quotes and dry-runs with
// the same core as the CLI; signing happens in the browser through Talisman.
// Holds no keys and never submits anything itself.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import BigNumber from 'bignumber.js';
import { connect, loadMarket, resolveAccount, type Chain } from './core/chain.js';
import { batch, dryRun, quotePlan } from './core/build.js';
import { capLegs, fitToBalances, planLegsTo, valueUsd, type Position } from './core/plan.js';

const HOST = process.env.REBALANCER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.REBALANCER_PORT ?? 5180);
const RPC = process.env.REBALANCER_RPC ?? 'wss://rpc.hydradx.cloud';
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

const toJsonPosition = (p: Position) => ({ ...p, balance: p.balance.toFixed() });

async function market(chain: Chain, address: string) {
  const who = await resolveAccount(chain.api, address);
  const m = await loadMarket(chain, who);
  return { who, ...m };
}

interface PlanRequest {
  address: string;
  weights: Record<string, number>; // reserveId -> weight (any scale)
  slippagePct: number;
  minHf: number;
  maxImpactPct: number;
  maxChunks: number;
  maxUsd?: number;
  minLegUsd: number;
}

async function plan(chain: Chain, req: PlanRequest) {
  const { who, account, chainHf } = await market(chain, req.address);
  const byReserve = new Map(account.positions.map((p) => [p.reserveId, p]));
  const target = new Map(Object.entries(req.weights).map(([k, v]) => [Number(k), Number(v)]));
  // the rebalanced set: everything with a target weight, plus held collateral set to 0
  const set = account.positions.filter((p) => target.has(p.reserveId));
  if (set.length < 2) throw new Error('pick at least two assets');

  let legs = planLegsTo(set, target, req.minLegUsd);
  legs = fitToBalances(legs, set, req.slippagePct);
  if (req.maxUsd && req.maxUsd > 0) legs = capLegs(legs, req.maxUsd, (id) => byReserve.get(id)!.decimals);
  if (!legs.length) return { who, chainHf, legs: [], calls: [], note: 'already at target' };

  const { calls, hfs } = await quotePlan(chain, account, legs, byReserve, req);
  const rows = calls.map((c, n) => {
    const from = byReserve.get(c.leg.from)!;
    const to = byReserve.get(c.leg.to)!;
    const oracleIn = (c.amountOut.toNumber() * to.priceUsd) / from.priceUsd;
    return {
      from: c.leg.from,
      to: c.leg.to,
      fromSymbol: from.symbol,
      toSymbol: to.symbol,
      amountOut: c.amountOut.toFixed(),
      amountIn: c.amountIn.toFixed(),
      maxAmountIn: c.maxAmountIn.toFixed(),
      usd: c.amountOut.toNumber() * to.priceUsd,
      impactPct: (c.amountIn.toNumber() / oracleIn - 1) * 100,
      route: c.route,
      hfAfterWithdraw: hfs[n].hfAfterWithdraw,
      hfAfterSupply: hfs[n].hfAfterSupply,
    };
  });

  const problems: string[] = [];
  const worstHf = Math.min(...hfs.map((h) => h.hfAfterWithdraw));
  if (worstHf < req.minHf) problems.push(`withdraw 直後の HF が ${worstHf.toFixed(3)} まで下がります（下限 ${req.minHf}）`);
  const worstImpact = Math.max(...rows.map((r) => r.impactPct));
  if (worstImpact > req.maxImpactPct) {
    problems.push(`プライスインパクトが ${worstImpact.toFixed(2)}% あります（上限 ${req.maxImpactPct}%）`);
  }
  const notCollateral = set.filter((p) => !p.isCollateral && p.balance.gt(0) && (target.get(p.reserveId) ?? 0) > 0);
  for (const p of notCollateral) problems.push(`${p.symbol} は担保が無効のまま保有しています（買い増しても HF に入りません）`);

  const tx = batch(chain.api, calls);
  const sim = await dryRun(chain.api, who, tx);
  if (!sim.ok) problems.push(`dry-run 失敗: ${sim.error}`);
  const info = await tx.paymentInfo(who.ss58).catch(() => null);

  return {
    who,
    chainHf,
    legs: legs.map((l) => ({ ...l, amountOut: l.amountOut.toFixed() })),
    calls: rows,
    dryRun: sim,
    feeHdx: info ? new BigNumber(info.partialFee.toString()).shiftedBy(-12).toNumber() : null,
    callHex: tx.method.toHex(),
    callHash: tx.method.hash.toHex(),
    quotedAt: Date.now(),
    positions: account.positions.map(toJsonPosition), // the prices this quote was checked against
    problems,
    movedUsd: rows.reduce((s, r) => s + r.usd, 0),
    totalUsd: set.reduce((s, p) => s + valueUsd(p), 0),
  };
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('request too large');
  }
  return JSON.parse(raw || '{}');
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function serveStatic(res: ServerResponse, path: string) {
  const file = normalize(join(WEB_DIR, path === '/' ? 'index.html' : path));
  if (!file.startsWith(WEB_DIR)) return send(res, 404, { error: 'not found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

async function main() {
  console.log(`connecting to ${RPC} …`);
  const chain = await connect(RPC);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    try {
      if (url.pathname === '/api/config') return send(res, 200, { rpc: RPC });
      if (url.pathname === '/api/market' && req.method === 'GET') {
        const m = await market(chain, url.searchParams.get('address') ?? '');
        return send(res, 200, {
          ...m,
          account: { ...m.account, positions: m.account.positions.map(toJsonPosition) },
          debts: m.debts.map((d) => ({ ...d, amount: d.amount.toFixed() })),
          frozen: [...m.frozen],
        });
      }
      if (url.pathname === '/api/plan' && req.method === 'POST') return send(res, 200, await plan(chain, await body(req)));
      if (req.method === 'GET') return serveStatic(res, url.pathname);
      send(res, 405, { error: 'method not allowed' });
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(PORT, HOST, () => console.log(`rebalancer UI: http://${HOST}:${PORT}`));
  const stop = () => {
    server.close();
    chain.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
