// Browser side of the rebalancer UI: sliders, risk preview, Talisman signing.
// Quotes and dry-runs come from the local server; this page decodes the call
// it is about to sign and checks every swap in it against the quote before
// handing it to Talisman.
import { ApiPromise, WsProvider } from '@polkadot/api';
import BigNumber from 'bignumber.js';
import { applyTrades, risk, valueUsd, type Position, type Risk } from '../core/plan.js';
import { decodeBatch, verifyBuys, type VerifyLimits } from '../core/verify.js';

interface Debt { reserveId: number; symbol: string; amount: string; usd: number }
interface PlanRow {
  from: number; to: number; fromSymbol: string; toSymbol: string;
  amountOut: string; amountIn: string; maxAmountIn: string; usd: number;
  impactPct: number; route: string; hfAfterWithdraw: number; hfAfterSupply: number;
}
interface PlanResult {
  who: { ss58: string; evm: string };
  calls: PlanRow[]; note?: string;
  dryRun?: { ok: boolean; error?: string; events: string[] };
  feeHdx?: number | null; callHex?: string; callHash?: string;
  quotedAt?: number; problems?: string[]; movedUsd?: number; totalUsd?: number;
  positions?: (Omit<Position, 'balance'> & { balance: string })[];
}
interface InjectedAccount { address: string; name?: string; type?: string }
interface Injected { accounts: { get(): Promise<InjectedAccount[]> }; signer: any }

const QUOTE_TTL_MS = 60_000;
const COLORS = ['#2f6fdf', '#e0a84a', '#4cc38a', '#c05bd6', '#f07171', '#3bb3c3', '#8a8f98', '#d68a3b'];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtUsd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const fmtPct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
const fmtHf = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '∞');
const fmtAmt = (s: string | BigNumber, d = 6) => new BigNumber(s).toFormat(d, BigNumber.ROUND_DOWN);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const state = {
  address: '',
  source: 'manual' as 'manual' | 'talisman',
  injected: null as Injected | null,
  positions: [] as Position[],
  debts: [] as Debt[],
  debtUsd: 0,
  chainHf: 0,
  frozen: new Set<number>(),
  included: [] as number[],           // reserveIds in the rebalanced set, in display order
  weights: new Map<number, number>(), // raw slider values, normalized for display
  plan: null as PlanResult | null,
  limits: null as VerifyLimits | null, // slippage / impact the current plan was quoted with
  api: null as ApiPromise | null,
  rpc: 'wss://rpc.hydradx.cloud',
};

const byId = (id: number) => state.positions.find((p) => p.reserveId === id)!;
const colorOf = (id: number) => COLORS[state.included.indexOf(id) % COLORS.length];

function status(msg: string, cls = 'muted') {
  const el = $('status');
  el.className = cls;
  el.textContent = msg;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

// ---------- loading ----------

async function connectTalisman() {
  const ext = (window as any).injectedWeb3?.talisman;
  if (!ext) {
    status('Talisman が見つかりません。拡張機能を有効にして、このページを再読み込みしてください。', 'bad');
    return;
  }
  state.injected = (await ext.enable('Hydration Rebalancer')) as Injected;
  const accounts = (await state.injected.accounts.get()).filter((a) => !a.address.startsWith('0x'));
  if (!accounts.length) {
    status('Talisman に Polkadot 形式のアカウントがありません。', 'bad');
    return;
  }
  const sel = $<HTMLSelectElement>('accounts');
  sel.innerHTML = accounts
    .map((a) => `<option value="${esc(a.address)}">${esc(a.name ?? '')} ${esc(a.address.slice(0, 8))}…${esc(a.address.slice(-6))}</option>`)
    .join('');
  sel.hidden = false;
  sel.onchange = () => load(sel.value, 'talisman');
  await load(accounts[0].address, 'talisman');
}

async function load(address: string, source: 'manual' | 'talisman') {
  status('読み込み中…');
  try {
    const m = await api<any>(`/api/market?address=${encodeURIComponent(address.trim())}`);
    state.address = address.trim();
    state.source = source;
    state.positions = m.account.positions.map((p: any) => ({ ...p, balance: new BigNumber(p.balance) }));
    state.debtUsd = m.account.debtUsd;
    state.debts = m.debts;
    state.chainHf = m.chainHf;
    state.frozen = new Set(m.frozen);
    state.included = state.positions.filter((p) => p.isCollateral && p.balance.gt(0)).map((p) => p.reserveId);
    setEqual();
    state.plan = null;
    $('app').hidden = false;
    status(
      `${m.who.ss58}  (EVM ${m.who.evm})${source === 'manual' ? ' — 読み取り専用。署名するには Talisman に接続してください。' : ''}`,
    );
    render();
  } catch (e) {
    status(`読み込めませんでした: ${(e as Error).message}`, 'bad');
  }
}

// ---------- weights ----------

function setEqual() {
  state.weights = new Map(state.included.map((id) => [id, 50]));
}

function setCurrent() {
  const total = state.included.reduce((s, id) => s + valueUsd(byId(id)), 0);
  state.weights = new Map(state.included.map((id) => [id, total > 0 ? (valueUsd(byId(id)) / total) * 100 : 0]));
}

function targetShares(): Map<number, number> {
  const sum = state.included.reduce((s, id) => s + (state.weights.get(id) ?? 0), 0);
  return new Map(state.included.map((id) => [id, sum > 0 ? (state.weights.get(id) ?? 0) / sum : 0]));
}

/** Oracle-priced, cost-free picture of the portfolio at the target weights. */
function estimatedTargetPositions(): Position[] {
  const shares = targetShares();
  const total = state.included.reduce((s, id) => s + valueUsd(byId(id)), 0);
  return state.positions.map((p) => {
    if (!shares.has(p.reserveId)) return p;
    const usd = total * shares.get(p.reserveId)!;
    return { ...p, balance: new BigNumber(usd / p.priceUsd), isCollateral: p.isCollateral || (usd > 0 && p.ltv > 0) };
  });
}

function quotedPositions(): Position[] | null {
  const plan = state.plan;
  if (!plan?.calls?.length) return null;
  return applyTrades(
    state.positions,
    plan.calls.map((c) => ({ from: c.from, to: c.to, amountIn: new BigNumber(c.amountIn), amountOut: new BigNumber(c.amountOut) })),
  );
}

// ---------- rendering ----------

function render() {
  renderAssets();
  renderRisk();
  renderPlan();
}

function renderAssets() {
  const shares = targetShares();
  const total = state.included.reduce((s, id) => s + valueUsd(byId(id)), 0);
  const rows = state.included.map((id) => {
    const p = byId(id);
    const now = total > 0 ? valueUsd(p) / total : 0;
    const tgt = shares.get(id) ?? 0;
    const diff = tgt * total - valueUsd(p);
    const raw = state.weights.get(id) ?? 0;
    const tags = [
      !p.isCollateral && p.balance.gt(0) ? '<span class="tag bad">担保オフ</span>' : '',
      p.balance.isZero() ? '<span class="tag">未保有</span>' : '',
      state.frozen.has(id) ? '<span class="tag bad">凍結</span>' : '',
    ].join('');
    return `<tr>
      <td><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${colorOf(id)};margin-right:6px"></i><b>${esc(p.symbol)}</b>${tags}</td>
      <td class="num">${fmtAmt(p.balance)}</td>
      <td class="num">${fmtUsd(p.priceUsd)}</td>
      <td class="num">${fmtUsd(valueUsd(p))}</td>
      <td class="num">${fmtPct(now)}</td>
      <td class="slider"><input type="range" min="0" max="100" step="0.5" value="${raw}" data-id="${id}">
        <input type="number" min="0" max="100" step="0.5" value="${(tgt * 100).toFixed(1)}" data-pct="${id}" style="width:64px"> %</td>
      <td class="num ${Math.abs(diff) < 1 ? 'muted' : diff > 0 ? 'good' : 'warn'}">${diff >= 0 ? '+' : '−'}${fmtUsd(Math.abs(diff))}</td>
      <td class="num muted">${fmtPct(p.liqThreshold, 0)} / ${fmtPct(p.ltv, 0)}</td>
      <td>${p.balance.isZero() ? `<button data-remove="${id}">外す</button>` : ''}</td>
    </tr>`;
  });
  $('assets').innerHTML = `<tr><th>資産</th><th>残高</th><th>価格</th><th>評価額</th><th>現在</th><th>目標</th><th>差額</th><th>LT / LTV</th><th></th></tr>${rows.join('')}`;

  // sliders: raw weights; the % box sets this asset's share and rescales the others
  $('assets').querySelectorAll<HTMLInputElement>('input[type=range]').forEach((el) => {
    el.oninput = () => {
      state.weights.set(Number(el.dataset.id), Number(el.value));
      invalidatePlan();
      renderAssets();
      renderRisk();
    };
  });
  $('assets').querySelectorAll<HTMLInputElement>('input[data-pct]').forEach((el) => {
    el.onchange = () => {
      setShare(Number(el.dataset.pct), Math.min(100, Math.max(0, Number(el.value))) / 100);
      invalidatePlan();
      render();
    };
  });
  $('assets').querySelectorAll<HTMLButtonElement>('button[data-remove]').forEach((el) => {
    el.onclick = () => {
      const id = Number(el.dataset.remove);
      state.included = state.included.filter((x) => x !== id);
      state.weights.delete(id);
      invalidatePlan();
      render();
    };
  });

  const bar = (shareOf: (id: number) => number) =>
    state.included.map((id) => `<div style="width:${shareOf(id) * 100}%;background:${colorOf(id)}" title="${esc(byId(id).symbol)}"></div>`).join('');
  $('bar-now').innerHTML = bar((id) => (total > 0 ? valueUsd(byId(id)) / total : 0));
  $('bar-target').innerHTML = bar((id) => shares.get(id) ?? 0);
  $('legend').innerHTML = state.included.map((id) => `<span><i style="background:${colorOf(id)}"></i>${esc(byId(id).symbol)}</span>`).join('');

  const drift = Math.max(0, ...state.included.map((id) => Math.abs((total > 0 ? valueUsd(byId(id)) / total : 0) - (shares.get(id) ?? 0))));
  $('drift').textContent = `目標との最大のずれ ${(drift * 100).toFixed(1)} pt ・ 合計 ${fmtUsd(total)}`;

  const addable = state.positions.filter((p) => !state.included.includes(p.reserveId) && p.ltv > 0 && !state.frozen.has(p.reserveId));
  $('add').innerHTML = `<option value="">＋ 資産を追加</option>${addable
    .map((p) => `<option value="${p.reserveId}">${esc(p.symbol)}${p.balance.gt(0) ? `（保有 ${fmtUsd(valueUsd(p))}）` : ''}</option>`)
    .join('')}`;

  const others = state.positions.filter((p) => p.isCollateral && p.balance.gt(0) && !state.included.includes(p.reserveId));
  $('others').textContent = others.length
    ? `対象外の担保（そのまま、HF には含む）: ${others.map((p) => `${p.symbol} ${fmtUsd(valueUsd(p))}`).join(', ')}`
    : '';
}

/** Set one asset's share to `share` and scale the others to fill the rest. */
function setShare(id: number, share: number) {
  const others = state.included.filter((x) => x !== id);
  const otherSum = others.reduce((s, x) => s + (state.weights.get(x) ?? 0), 0);
  const total = 100;
  state.weights.set(id, share * total);
  for (const x of others) {
    const w = otherSum > 0 ? (state.weights.get(x) ?? 0) / otherSum : 1 / others.length;
    state.weights.set(x, w * (1 - share) * total);
  }
}

function hfClass(hf: number) {
  const minHf = Number($<HTMLInputElement>('o-minhf').value);
  return hf < 1.1 ? 'bad' : hf < minHf ? 'warn' : 'good';
}

function gauge(label: string, hf: number) {
  const max = 4;
  const pos = (v: number) => `${(Math.min(v, max) / max) * 100}%`;
  const minHf = Number($<HTMLInputElement>('o-minhf').value);
  const color = `var(--${hfClass(hf)})`;
  return `<div class="row" style="justify-content:space-between;margin-top:14px"><span class="muted">${label}</span><b class="${hfClass(hf)}">${fmtHf(hf)}</b></div>
    <div class="gauge"><div class="fill" style="width:${pos(hf)};background:${color}"></div>
      <div class="mark" style="left:${pos(1)}"><span>1.0</span></div>
      <div class="mark min" style="left:${pos(minHf)}"><span>下限 ${minHf}</span></div></div>`;
}

function renderRisk() {
  const now = risk(state.positions, state.debtUsd);
  const est = risk(estimatedTargetPositions(), state.debtUsd);
  const qp = quotedPositions();
  const quoted = qp ? risk(qp, state.debtUsd) : null;
  const worstMid = state.plan?.calls?.length ? Math.min(...state.plan.calls.map((c) => c.hfAfterWithdraw)) : null;

  $('gauges').innerHTML =
    gauge('現在', now.hf) +
    gauge('目標（概算）', est.hf) +
    (quoted ? gauge('見積もり後', quoted.hf) : '') +
    (worstMid != null ? gauge('途中の最低（withdraw 直後）', worstMid) : '');

  const cols: [string, Risk | null][] = [['現在', now], ['目標（概算）', est], ['見積もり後', quoted]];
  const row = (label: string, f: (r: Risk) => string) =>
    `<tr><td>${label}</td>${cols.map(([, r]) => `<td class="num">${r ? f(r) : '—'}</td>`).join('')}</tr>`;
  const drop = (x: number | null) => (x == null ? '清算なし' : fmtPct(x));
  const assetRows = state.included
    .map((id) => row(`${esc(byId(id).symbol)} だけ下落で清算`, (r) => drop(r.assetDropToLiq.get(id) ?? null)))
    .join('');
  $('risk').innerHTML =
    `<tr><th></th>${cols.map(([h]) => `<th>${h}</th>`).join('')}</tr>` +
    row('Health factor', (r) => `<span class="${hfClass(r.hf)}">${fmtHf(r.hf)}</span>`) +
    row('担保合計', (r) => fmtUsd(r.collateralUsd)) +
    row('平均 LT', (r) => fmtPct(r.avgLt)) +
    row('借入枠の使用率', (r) => fmtPct(r.utilization)) +
    row('全担保一律の下落で清算', (r) => drop(r.uniformDropToLiq)) +
    assetRows;

  const nonStable = state.debts.filter((d) => !/USD|DAI|HOLLAR|EUR/i.test(d.symbol));
  $('debts').innerHTML =
    `借入: ${state.debts.map((d) => `${esc(d.symbol)} ${fmtAmt(d.amount, 2)} (${fmtUsd(d.usd)})`).join(', ') || 'なし'}` +
    (nonStable.length ? ` <span class="warn">— ステーブル以外の借入があるため、下落率の数字は目安です。</span>` : '');
}

function invalidatePlan() {
  if (!state.plan) return;
  state.plan = null;
  renderPlan();
}

function renderPlan() {
  const plan = state.plan;
  const signBtn = $<HTMLButtonElement>('sign');
  if (!plan) {
    $('plan').innerHTML = '';
    signBtn.disabled = true;
    $('age').textContent = '';
    return;
  }
  if (!plan.calls.length) {
    $('plan').innerHTML = `<p class="muted">${esc(plan.note ?? '交換は不要です')}</p>`;
    signBtn.disabled = true;
    return;
  }
  const rows = plan.calls
    .map(
      (c, i) => `<tr>
      <td>${i + 1}. ${esc(c.fromSymbol)} → ${esc(c.toSymbol)}</td>
      <td class="num">${fmtAmt(c.amountOut)} a${esc(c.toSymbol)}</td>
      <td class="num">${fmtAmt(c.amountIn)} <span class="muted">(≤ ${fmtAmt(c.maxAmountIn)})</span> a${esc(c.fromSymbol)}</td>
      <td class="num">${fmtUsd(c.usd)}</td>
      <td class="num ${c.impactPct > Number($<HTMLInputElement>('o-impact').value) ? 'bad' : ''}">${c.impactPct >= 0 ? '+' : ''}${c.impactPct.toFixed(2)}%</td>
      <td class="num ${hfClass(c.hfAfterWithdraw)}">${fmtHf(c.hfAfterWithdraw)}</td>
      <td class="num">${fmtHf(c.hfAfterSupply)}</td>
      <td class="muted" style="text-align:left;font-size:11px">${esc(c.route)}</td></tr>`,
    )
    .join('');
  const problems = plan.problems ?? [];
  $('plan').innerHTML = `
    <div class="table-wrap" style="margin-top:12px"><table>
      <tr><th>スワップ</th><th>受け取る（確定）</th><th>支払う（見積もり / 上限）</th><th>USD</th><th>oracle 比</th><th>withdraw 直後 HF</th><th>交換後 HF</th><th>ルート</th></tr>
      ${rows}</table></div>
    <p class="muted">${plan.calls.length} 件のスワップを 1 トランザクションにまとめます。動かす額 ${fmtUsd(plan.movedUsd ?? 0)} / 対象合計 ${fmtUsd(plan.totalUsd ?? 0)}。手数料の目安 ${plan.feeHdx != null ? plan.feeHdx.toFixed(3) + ' HDX' : '—'}。</p>
    ${problems.length ? `<div class="problems">${problems.map(esc).join('<br>')}</div>` : `<div class="ok-box">dry-run OK。チェックはすべて通りました。</div>`}
    <details><summary>call data（polkadot.js apps で Decode して署名する場合）</summary>
      <p class="muted">call hash ${esc(plan.callHash ?? '')}</p><pre>${esc(plan.callHex ?? '')}</pre></details>`;
  updateSignButton();
}

function updateSignButton() {
  const plan = state.plan;
  const btn = $<HTMLButtonElement>('sign');
  const fresh = plan?.quotedAt ? Date.now() - plan.quotedAt < QUOTE_TTL_MS : false;
  const ok = !!plan?.calls.length && !!plan.dryRun?.ok && !(plan.problems ?? []).length;
  btn.disabled = !(ok && fresh && state.source === 'talisman');
  btn.title = state.source !== 'talisman' ? 'Talisman に接続すると署名できます' : !fresh ? '見積もりが古くなりました。もう一度見積もってください' : '';
  if (plan?.quotedAt) {
    const left = Math.max(0, Math.ceil((QUOTE_TTL_MS - (Date.now() - plan.quotedAt)) / 1000));
    $('age').textContent = left > 0 ? `見積もりの有効時間 あと ${left} 秒` : '見積もりが古くなりました。もう一度見積もってください。';
  }
}

// ---------- quote & sign ----------

async function quote() {
  const btn = $<HTMLButtonElement>('quote');
  btn.disabled = true;
  btn.textContent = '見積もり中…';
  try {
    const num = (id: string) => Number($<HTMLInputElement>(id).value);
    const shares = targetShares();
    const limits = { slippagePct: num('o-slip'), maxImpactPct: num('o-impact') };
    // held collateral that is not in the set is left alone; in-set assets carry their share (0 = sell)
    state.plan = await api<PlanResult>('/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: state.address,
        weights: Object.fromEntries([...shares].map(([k, v]) => [String(k), v])),
        ...limits,
        minHf: num('o-minhf'),
        maxChunks: num('o-chunks'),
        maxUsd: $<HTMLInputElement>('o-maxusd').value ? num('o-maxusd') : undefined,
        minLegUsd: num('o-minleg'),
      }),
    });
    state.limits = limits;
    // refresh balances and oracle prices to the ones the quote used; signing checks against them
    if (state.plan.positions) state.positions = state.plan.positions.map((p) => ({ ...p, balance: new BigNumber(p.balance) }));
  } catch (e) {
    state.plan = null;
    $('plan').innerHTML = `<div class="problems">${esc((e as Error).message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '見積もり＋dry-run';
  }
  if (state.plan) render();
}

async function chainApi(): Promise<ApiPromise> {
  if (!state.api) state.api = await ApiPromise.create({ provider: new WsProvider(state.rpc), noInitWarn: true });
  return state.api;
}

async function sign() {
  const plan = state.plan;
  if (!plan?.callHex || !state.injected || !state.limits) return;
  const btn = $<HTMLButtonElement>('sign');
  btn.disabled = true;
  try {
    const chain = await chainApi();
    // decode what we are about to sign ourselves and check every swap in it
    // against the quote on screen, so the confirm text below is what gets signed
    const call = chain.createType('Call', plan.callHex);
    let verified;
    try {
      if (call.hash.toHex() !== plan.callHash) throw new Error('call hash が見積もりと一致しません');
      verified = verifyBuys(decodeBatch(call), plan.calls, state.positions, state.limits);
    } catch (e) {
      throw new Error(`署名を中止しました: ${(e as Error).message}`);
    }

    const summary = verified
      .map((v, i) => {
        const worst = `${v.worstVsOraclePct >= 0 ? '+' : ''}${v.worstVsOraclePct.toFixed(2)}%`;
        return `${i + 1}. ${fmtAmt(v.amountOut)} a${v.to.symbol} を最大 ${fmtAmt(v.maxAmountIn)} a${v.from.symbol} で買う（最悪 oracle 比 ${worst}）`;
      })
      .join('\n');
    if (!confirm(`次の内容で署名します（1 トランザクション）。\n\n${summary}\n\ncall hash ${plan.callHash}\n\nTalisman / Ledger の画面でも内容を確認してください。`)) {
      updateSignButton();
      return;
    }

    const tx = chain.tx(call);
    status('Talisman で署名してください…');
    await new Promise<void>((resolve, reject) => {
      tx.signAndSend(state.address, { signer: state.injected!.signer, withSignedTransaction: true }, (result) => {
        if (result.status.isInBlock || result.status.isFinalized) {
          const failed = result.events.find(({ event }) =>
            chain.events.system.ExtrinsicFailed.is(event) || chain.events.utility.BatchInterrupted.is(event),
          );
          if (failed) {
            reject(new Error(`ブロックに入りましたが失敗しました（全体が取り消されています）: ${failed.event.section}.${failed.event.method}`));
          } else if (result.status.isInBlock) {
            status(`ブロックに入りました: ${result.status.asInBlock.toHex()}`, 'good');
            resolve();
          }
        } else if (result.isError) {
          reject(new Error(`送信エラー: ${result.status.type}`));
        } else {
          status(`送信中… ${result.status.type}`);
        }
      }).catch(reject);
    });
    state.plan = null;
    await load(state.address, 'talisman');
    status('完了しました。残高を読み直しました。', 'good');
  } catch (e) {
    status((e as Error).message, 'bad');
    updateSignButton();
  }
}

// ---------- wiring ----------

$('connect').onclick = () => connectTalisman().catch((e) => status(e.message, 'bad'));
$('load').onclick = () => load($<HTMLInputElement>('address').value, 'manual');
$('equal').onclick = () => { setEqual(); invalidatePlan(); render(); };
$('current').onclick = () => { setCurrent(); invalidatePlan(); render(); };
$('add').onchange = () => {
  const id = Number($<HTMLSelectElement>('add').value);
  if (!id) return;
  state.included.push(id);
  setShare(id, 1 / state.included.length);
  invalidatePlan();
  render();
};
$('quote').onclick = quote;
$('sign').onclick = sign;
document.querySelectorAll('.opts input').forEach((el) => el.addEventListener('change', () => { invalidatePlan(); renderRisk(); }));
setInterval(() => state.plan && updateSignButton(), 1000);
api<{ rpc: string }>('/api/config').then((c) => (state.rpc = c.rpc)).catch(() => {});
