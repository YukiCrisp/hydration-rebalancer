// Browser side of the rebalancer UI: sliders, risk preview, Talisman signing.
// Quotes and dry-runs come from the local server; this page decodes the call
// it is about to sign and checks every swap in it against the quote before
// handing it to Talisman.
import { ApiPromise, WsProvider } from '@polkadot/api';
import BigNumber from 'bignumber.js';
import { applyTrades, risk, valueUsd, withDeposits, type Position, type Risk } from '../core/plan.js';
import { decodeBatch, verifyBuys, type VerifyLimits } from '../core/verify.js';

interface Debt { reserveId: number | null; symbol: string; amount: string; priceUsd: number; usd: number; apr: number; stable: boolean }
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
  positions: [] as Position[],        // on-chain balances
  view: [] as Position[],             // what the page works with: on-chain, plus planned deposits in simulation
  sim: false,
  addSupply: new Map<number, string>(), // reserveId -> planned deposit (token units, as typed)
  addBorrow: new Map<string, string>(), // debtKey -> planned extra borrow (token units, as typed)
  newBorrows: [] as number[],           // reserveIds with a planned borrow but no current debt
  debts: [] as Debt[],
  debtUsd: 0,
  chainHf: 0,
  frozen: new Set<number>(),
  included: [] as number[],           // reserveIds in the rebalanced set, in display order
  weights: new Map<number, number>(), // target % per asset, summing to 100
  pinned: [] as number[],             // assets the user set by hand, oldest first; they hold while others absorb
  plan: null as PlanResult | null,
  limits: null as VerifyLimits | null, // slippage / impact the current plan was quoted with
  api: null as ApiPromise | null,
  rpc: 'wss://rpc.hydradx.cloud',
};

const byId = (id: number) => state.view.find((p) => p.reserveId === id)!;
const onChain = (id: number) => state.positions.find((p) => p.reserveId === id)!;

// ---------- simulation ----------

const debtKey = (d: { reserveId: number | null; symbol: string }) => String(d.reserveId ?? d.symbol);
const typed = (s: string | undefined) => {
  const n = new BigNumber(s ?? '');
  return n.isFinite() && n.gt(0) ? n : new BigNumber(0);
};

/** Recompute the working positions from on-chain balances and, in simulation, the planned deposits. */
function applySim() {
  if (!state.sim) {
    state.view = state.positions;
    return;
  }
  state.view = withDeposits(state.positions, new Map([...state.addSupply].map(([id, s]) => [id, typed(s)])));
}

/** Planned extra borrows as rows: existing debts first, then new ones. */
function plannedBorrows(): { key: string; symbol: string; priceUsd: number; amount: BigNumber }[] {
  if (!state.sim) return [];
  const rows = [
    ...state.debts.map((d) => ({ key: debtKey(d), symbol: d.symbol, priceUsd: d.priceUsd })),
    ...state.newBorrows.map((id) => ({ key: String(id), symbol: onChain(id).symbol, priceUsd: onChain(id).priceUsd })),
  ];
  return rows.map((r) => ({ ...r, amount: typed(state.addBorrow.get(r.key)) }));
}

/** Debt the page works with: the chain's total, plus planned borrows in simulation. */
const debtUsd = () => state.debtUsd + plannedBorrows().reduce((s, b) => s + b.amount.toNumber() * b.priceUsd, 0);

function setSim(on: boolean) {
  state.sim = on;
  if (!on) {
    state.addSupply.clear();
    state.addBorrow.clear();
    state.newBorrows = [];
  }
  applySim();
  state.plan = null;
  $('app').classList.toggle('sim', on);
  render();
}
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
    // planned amounts survive a reload (e.g. switching accounts keeps the what-if)
    state.newBorrows = state.newBorrows.filter((id) => !state.debts.some((d) => d.reserveId === id));
    applySim();
    state.included = state.view.filter((p) => p.isCollateral && p.balance.gt(0)).map((p) => p.reserveId);
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
  state.weights = new Map(state.included.map((id) => [id, 100 / state.included.length]));
  state.pinned = [];
}

function setCurrent() {
  const total = state.included.reduce((s, id) => s + valueUsd(byId(id)), 0);
  state.weights = new Map(state.included.map((id) => [id, total > 0 ? (valueUsd(byId(id)) / total) * 100 : 0]));
  state.pinned = [];
}

function targetShares(): Map<number, number> {
  const sum = state.included.reduce((s, id) => s + (state.weights.get(id) ?? 0), 0);
  return new Map(state.included.map((id) => [id, sum > 0 ? (state.weights.get(id) ?? 0) / sum : 0]));
}

/** Oracle-priced, cost-free picture of the portfolio at the target weights. */
function estimatedTargetPositions(): Position[] {
  const shares = targetShares();
  const total = state.included.reduce((s, id) => s + valueUsd(byId(id)), 0);
  return state.view.map((p) => {
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
  renderBorrows();
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
    const pinned = state.pinned.includes(id);
    const tags = [
      !p.isCollateral && p.balance.gt(0) ? '<span class="tag bad">担保オフ</span>' : '',
      p.balance.isZero() ? '<span class="tag">未保有</span>' : '',
      state.frozen.has(id) ? '<span class="tag bad">凍結</span>' : '',
    ].join('');
    return `<tr>
      <td><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${colorOf(id)};margin-right:6px"></i><b>${esc(p.symbol)}</b>${tags}</td>
      <td class="num">${fmtAmt(onChain(id).balance)}</td>
      ${state.sim ? `<td class="num add"><input type="number" min="0" step="any" placeholder="0" value="${esc(state.addSupply.get(id) ?? '')}" data-add="${id}"></td>` : ''}
      <td class="num">${fmtUsd(p.priceUsd)}</td>
      <td class="num">${fmtUsd(valueUsd(p))}</td>
      <td class="num">${fmtPct(now)}</td>
      <td class="slider"><input type="range" min="0" max="100" step="0.5" value="${tgt * 100}" data-id="${id}">
        <input type="number" min="0" max="100" step="0.5" value="${(tgt * 100).toFixed(1)}" data-pct="${id}" style="width:64px"> %
        <button class="${pinClass(pinned)}" data-unpin="${id}" ${pinned ? '' : 'disabled'} title="${pinTitle(pinned)}">${pinned ? '固定' : '自動'}</button></td>
      <td class="${diffClass(diff)}" data-diff="${id}">${fmtDiff(diff)}</td>
      <td class="num muted">${fmtPct(p.liqThreshold, 0)} / ${fmtPct(p.ltv, 0)}</td>
      <td>${onChain(id).balance.isZero() ? `<button data-remove="${id}">外す</button>` : ''}</td>
    </tr>`;
  });
  const head = state.sim
    ? '<th>資産</th><th>残高</th><th>追加予定</th><th>価格</th><th>入金後の評価額</th><th>入金後</th>'
    : '<th>資産</th><th>残高</th><th>価格</th><th>評価額</th><th>現在</th>';
  $('assets').innerHTML = `<tr>${head}<th>目標</th><th>差額</th><th>LT / LTV</th><th></th></tr>${rows.join('')}`;

  $('assets').querySelectorAll<HTMLInputElement>('input[data-add]').forEach((el) => {
    el.onchange = () => {
      const id = Number(el.dataset.add);
      if (typed(el.value).gt(0)) state.addSupply.set(id, el.value.trim());
      else state.addSupply.delete(id);
      applySim();
      // keep the current target weights; the new money is spread by them
      render();
    };
  });

  // slider and % box both set this asset's share and pin it; only unpinned assets absorb the change.
  // While dragging, update the rows in place: rebuilding the table would drop the slider mid-drag.
  $('assets').querySelectorAll<HTMLInputElement>('input[type=range]').forEach((el) => {
    el.oninput = () => {
      setShare(Number(el.dataset.id), Number(el.value) / 100);
      invalidatePlan();
      refreshTargets(el);
      renderRisk();
    };
  });
  $('assets').querySelectorAll<HTMLButtonElement>('button[data-unpin]').forEach((el) => {
    el.onclick = () => {
      unpin(Number(el.dataset.unpin));
      invalidatePlan();
      render();
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
      state.addSupply.delete(id);
      applySim();
      state.pinned = state.pinned.filter((x) => x !== id);
      // its share goes to the unpinned assets (or to everyone if all are pinned)
      if (state.included.every((x) => state.pinned.includes(x))) state.pinned = [];
      fillFree(100 - state.pinned.reduce((s, x) => s + (state.weights.get(x) ?? 0), 0));
      invalidatePlan();
      render();
    };
  });

  renderBars();

  const addable = state.view.filter((p) => !state.included.includes(p.reserveId) && p.ltv > 0 && !state.frozen.has(p.reserveId));
  $('add').innerHTML = `<option value="">＋ 資産を追加</option>${addable
    .map((p) => `<option value="${p.reserveId}">${esc(p.symbol)}${p.balance.gt(0) ? `（保有 ${fmtUsd(valueUsd(p))}）` : ''}</option>`)
    .join('')}`;

  const others = state.view.filter((p) => p.isCollateral && p.balance.gt(0) && !state.included.includes(p.reserveId));
  $('others').textContent = others.length
    ? `対象外の担保（そのまま、HF には含む）: ${others.map((p) => `${p.symbol} ${fmtUsd(valueUsd(p))}`).join(', ')}`
    : '';
}

const pinClass = (pinned: boolean) => `pin${pinned ? ' on' : ''}`;
const pinTitle = (pinned: boolean) => (pinned ? '固定を外す（他の資産の変更に合わせて動くようになります）' : '動かすと固定されます');
const diffClass = (diff: number) => `num ${Math.abs(diff) < 1 ? 'muted' : diff > 0 ? 'good' : 'warn'}`;
const fmtDiff = (diff: number) => `${diff >= 0 ? '+' : '−'}${fmtUsd(Math.abs(diff))}`;

/** Update target %, pin state and diff of every row in place, leaving `active` (the slider being dragged) alone. */
function refreshTargets(active: HTMLInputElement) {
  const shares = targetShares();
  const total = state.included.reduce((s, id) => s + valueUsd(byId(id)), 0);
  const table = $('assets');
  for (const id of state.included) {
    const tgt = shares.get(id) ?? 0;
    const pinned = state.pinned.includes(id);
    const range = table.querySelector<HTMLInputElement>(`input[data-id="${id}"]`)!;
    if (range !== active) range.value = String(tgt * 100);
    table.querySelector<HTMLInputElement>(`input[data-pct="${id}"]`)!.value = (tgt * 100).toFixed(1);
    const pin = table.querySelector<HTMLButtonElement>(`button[data-unpin="${id}"]`)!;
    pin.className = pinClass(pinned);
    pin.disabled = !pinned;
    pin.title = pinTitle(pinned);
    pin.textContent = pinned ? '固定' : '自動';
    const diff = tgt * total - valueUsd(byId(id));
    const cell = table.querySelector<HTMLElement>(`td[data-diff="${id}"]`)!;
    cell.className = diffClass(diff);
    cell.textContent = fmtDiff(diff);
  }
  renderBars();
}

function renderBars() {
  const shares = targetShares();
  const total = state.included.reduce((s, id) => s + valueUsd(byId(id)), 0);
  const bar = (shareOf: (id: number) => number) =>
    state.included.map((id) => `<div style="width:${shareOf(id) * 100}%;background:${colorOf(id)}" title="${esc(byId(id).symbol)}"></div>`).join('');
  $('bar-now-label').textContent = state.sim ? '入金後' : '現在';
  $('bar-now').innerHTML = bar((id) => (total > 0 ? valueUsd(byId(id)) / total : 0));
  $('bar-target').innerHTML = bar((id) => shares.get(id) ?? 0);
  $('legend').innerHTML = state.included.map((id) => `<span><i style="background:${colorOf(id)}"></i>${esc(byId(id).symbol)}</span>`).join('');

  const drift = Math.max(0, ...state.included.map((id) => Math.abs((total > 0 ? valueUsd(byId(id)) / total : 0) - (shares.get(id) ?? 0))));
  $('drift').textContent = `目標との最大のずれ ${(drift * 100).toFixed(1)} pt ・ 合計 ${fmtUsd(total)}`;
}

// Borrows are shown, never changed: the batch only moves collateral.
// In simulation, planned extra borrows are added on top for the risk numbers.
function renderBorrows() {
  const planned = new Map(plannedBorrows().map((b) => [b.key, b]));
  const rows = [
    ...state.debts.map((d) => ({ key: debtKey(d), symbol: d.symbol, amount: new BigNumber(d.amount), priceUsd: d.priceUsd, apr: d.apr as number | null, stable: d.stable })),
    ...(state.sim ? state.newBorrows : []).map((id) => ({ key: String(id), symbol: onChain(id).symbol, amount: new BigNumber(0), priceUsd: onChain(id).priceUsd, apr: null, stable: false })),
  ].map((r) => ({ ...r, usd: r.amount.plus(planned.get(r.key)?.amount ?? 0).toNumber() * r.priceUsd }));
  const cols = state.sim ? 7 : 6;
  const head = `<tr><th>資産</th><th>借入額</th>${state.sim ? '<th>追加予定</th>' : ''}<th>価格</th><th>${state.sim ? '入金後の評価額' : '評価額'}</th><th>比率</th><th>金利 (APR)</th></tr>`;
  const addRow = state.sim
    ? `<tr><td colspan="${cols}"><select id="add-borrow"><option value="">＋ 借入を追加</option>${state.positions
        .filter((p) => !rows.some((r) => r.key === String(p.reserveId)))
        .map((p) => `<option value="${p.reserveId}">${esc(p.symbol)}</option>`)
        .join('')}</select></td></tr>`
    : '';
  if (!rows.length) {
    $('borrows').innerHTML = `${head}<tr><td colspan="${cols}" class="muted">借入はありません</td></tr>${addRow}`;
    $('borrows-note').textContent = '';
    wireBorrows();
    return;
  }
  const rowsUsd = rows.reduce((s, r) => s + r.usd, 0);
  const body = rows.map((r) => `<tr>
      <td><b>${esc(r.symbol)}</b>${r.stable ? '<span class="tag">固定金利</span>' : ''}</td>
      <td class="num">${fmtAmt(r.amount)}</td>
      ${state.sim ? `<td class="num add"><input type="number" min="0" step="any" placeholder="0" value="${esc(state.addBorrow.get(r.key) ?? '')}" data-borrow="${esc(r.key)}"></td>` : ''}
      <td class="num">${fmtUsd(r.priceUsd)}</td>
      <td class="num">${fmtUsd(r.usd)}</td>
      <td class="num">${fmtPct(rowsUsd > 0 ? r.usd / rowsUsd : 0)}</td>
      <td class="num">${r.apr != null ? fmtPct(r.apr, 2) : '—'}</td>
    </tr>`);
  const total = state.sim
    ? `<td class="num"><b>${fmtUsd(debtUsd())}</b> <span class="muted">（現在 ${fmtUsd(state.debtUsd)}）</span></td>`
    : `<td class="num"><b>${fmtUsd(state.debtUsd)}</b></td>`;
  $('borrows').innerHTML = `${head}${body.join('')}
    <tr><td><b>合計</b></td><td></td>${state.sim ? '<td></td>' : ''}<td></td>${total}<td></td><td></td></tr>${addRow}`;
  // the total is the chain's own figure; flag it if the per-asset rows do not add up to it
  const chainRowsUsd = state.debts.reduce((s, d) => s + d.usd, 0);
  const gap = Math.abs(chainRowsUsd - state.debtUsd);
  $('borrows-note').innerHTML =
    `HF の計算には合計（チェーンの値${state.sim ? ' ＋ 追加予定' : ''}）を使います。` +
    (gap > Math.max(1, state.debtUsd * 0.01)
      ? ` <span class="warn">内訳の合計 ${fmtUsd(chainRowsUsd)} とチェーンの合計が ${fmtUsd(gap)} ずれています。</span>`
      : '');
  wireBorrows();
}

function wireBorrows() {
  $('borrows').querySelectorAll<HTMLInputElement>('input[data-borrow]').forEach((el) => {
    el.onchange = () => {
      if (typed(el.value).gt(0)) state.addBorrow.set(el.dataset.borrow!, el.value.trim());
      else state.addBorrow.delete(el.dataset.borrow!);
      render();
    };
  });
  const add = document.getElementById('add-borrow') as HTMLSelectElement | null;
  if (add) {
    add.onchange = () => {
      const id = Number(add.value);
      if (!id) return;
      state.newBorrows.push(id);
      render();
    };
  }
}

/**
 * Set one asset's share to `share` and pin it. Assets set earlier stay where
 * they are; only unpinned ones scale to fill the rest. When nothing unpinned
 * is left (or the pinned ones no longer fit), the oldest pins give way first.
 */
function setShare(id: number, share: number) {
  const pct = Math.min(100, Math.max(0, share * 100));
  state.weights.set(id, pct);
  state.pinned = [...state.pinned.filter((x) => x !== id && state.included.includes(x)), id];
  const held = () => state.pinned.filter((x) => x !== id);
  const heldSum = () => held().reduce((s, x) => s + (state.weights.get(x) ?? 0), 0);
  const free = () => state.included.filter((x) => !state.pinned.includes(x));
  while (held().length && (!free().length || heldSum() > 100 - pct)) {
    state.pinned = state.pinned.filter((x) => x !== held()[0]);
  }
  fillFree(100 - pct - heldSum());
}

/** Spread `rest` % over the unpinned assets, keeping their proportions. */
function fillFree(rest: number) {
  const free = state.included.filter((x) => !state.pinned.includes(x));
  const sum = free.reduce((s, x) => s + (state.weights.get(x) ?? 0), 0);
  for (const x of free) state.weights.set(x, Math.max(0, sum > 0 ? ((state.weights.get(x) ?? 0) / sum) * rest : rest / free.length));
}

function unpin(id: number) {
  state.pinned = state.pinned.filter((x) => x !== id);
  const pinnedSum = state.pinned.reduce((s, x) => s + (state.weights.get(x) ?? 0), 0);
  fillFree(100 - pinnedSum);
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
  const after = state.sim ? risk(state.view, debtUsd()) : null;
  const est = risk(estimatedTargetPositions(), debtUsd());
  const qp = quotedPositions();
  const quoted = qp ? risk(qp, state.debtUsd) : null;
  const worstMid = state.plan?.calls?.length ? Math.min(...state.plan.calls.map((c) => c.hfAfterWithdraw)) : null;

  $('gauges').innerHTML =
    gauge('現在', now.hf) +
    (after ? gauge('入金後', after.hf) : '') +
    gauge(after ? '入金後に目標比率（概算）' : '目標（概算）', est.hf) +
    (quoted ? gauge('見積もり後', quoted.hf) : '') +
    (worstMid != null ? gauge('途中の最低（withdraw 直後）', worstMid) : '');

  const cols: [string, Risk | null][] = after
    ? [['現在', now], ['入金後', after], ['入金後に目標比率（概算）', est]]
    : [['現在', now], ['目標（概算）', est], ['見積もり後', quoted]];
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
    row('借入合計', (r) => fmtUsd(r.debtUsd)) +
    row('平均 LT', (r) => fmtPct(r.avgLt)) +
    row('借入枠の使用率', (r) => fmtPct(r.utilization)) +
    row('全担保一律の下落で清算', (r) => drop(r.uniformDropToLiq)) +
    assetRows;

  const borrowed = [...state.debts.map((d) => d.symbol), ...plannedBorrows().filter((b) => b.amount.gt(0)).map((b) => b.symbol)];
  const nonStable = [...new Set(borrowed.filter((sym) => !/USD|DAI|HOLLAR|EUR/i.test(sym)))];
  $('debts').innerHTML = nonStable.length
    ? `<span class="warn">ステーブル以外の借入（${nonStable.map(esc).join(', ')}）があるため、下落率の数字は目安です。</span>`
    : '';
}

function invalidatePlan() {
  if (!state.plan) return;
  state.plan = null;
  renderPlan();
}

function renderPlan() {
  const plan = state.plan;
  const signBtn = $<HTMLButtonElement>('sign');
  const quoteBtn = $<HTMLButtonElement>('quote');
  // a what-if has no on-chain balances to swap from, so nothing here may be quoted or signed
  quoteBtn.disabled = state.sim;
  quoteBtn.title = state.sim ? 'シミュレーション中は見積もりも署名もできません' : '';
  if (state.sim) {
    $('plan').innerHTML = '<p class="muted">シミュレーション中です。入金を済ませてからシミュレーションをオフにすると、見積もりと署名ができます。</p>';
    signBtn.disabled = true;
    $('age').textContent = '';
    return;
  }
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
  if (state.sim) return;
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
    applySim();
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
$<HTMLInputElement>('sim').onchange = (e) => setSim((e.target as HTMLInputElement).checked);
$('sign').onclick = sign;
document.querySelectorAll('.opts input').forEach((el) => el.addEventListener('change', () => { invalidatePlan(); renderRisk(); }));
setInterval(() => state.plan && updateSignButton(), 1000);
api<{ rpc: string }>('/api/config').then((c) => (state.rpc = c.rpc)).catch(() => {});
