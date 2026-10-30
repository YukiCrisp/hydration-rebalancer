// Read-only chain access: account resolution, money-market positions, aToken mapping.
import { ApiPromise, WsProvider } from '@polkadot/api';
import { createSdkContext, type SdkCtx } from '@galacticcouncil/sdk';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { isHex, u8aToString } from '@polkadot/util';
import BigNumber from 'bignumber.js';
import type { Account, Position } from './plan.js';

export const HYDRATION_SS58 = 63;
// Aave oracle / UiPoolDataProvider prices use 8-decimal USD base currency.
const BASE_DECIMALS = 8;

export interface Chain {
  api: ApiPromise;
  sdk: SdkCtx;
  close(): Promise<void>;
}

export async function connect(rpc: string): Promise<Chain> {
  const api = await ApiPromise.create({ provider: new WsProvider(rpc), noInitWarn: true });
  // The SDK ships CJS only, so its ApiPromise type is the cjs declaration;
  // same runtime object, different TS identity.
  const sdk = createSdkContext(api as any);
  return {
    api,
    sdk,
    async close() {
      // The SDK keeps pool subscriptions with in-flight RPC calls; a clean
      // disconnect makes them reject unhandled. Stop them and let the CLI exit.
      sdk.destroy();
    },
  };
}

export interface Who {
  ss58: string;   // Substrate account (signer, Ledger)
  evm: string;    // H160 the money market sees
}

/** Accept either an SS58 address or an H160 and return both forms. */
export async function resolveAccount(api: ApiPromise, address: string): Promise<Who> {
  if (isHex(address) && address.length === 42) {
    const id = await api.call.evmAccountsApi.accountId(address);
    return { ss58: encodeAddress(id.toU8a(), HYDRATION_SS58), evm: address.toLowerCase() };
  }
  const ss58 = encodeAddress(decodeAddress(address), HYDRATION_SS58);
  const evm = (await api.call.evmAccountsApi.evmAddress(ss58)).toString().toLowerCase();
  return { ss58, evm };
}

/** reserve asset id -> aToken asset id, from the router's Aave executor. */
export async function aTokenMap(api: ApiPromise): Promise<Map<number, number>> {
  const pools = (await (api.call as any).aaveTradeExecutor.pools()) as any[];
  return new Map(pools.map((p) => [p.reserve.toNumber(), p.atoken.toNumber()]));
}

export async function symbolOf(api: ApiPromise, assetId: number): Promise<string> {
  const a: any = await api.query.assetRegistry.assets(assetId);
  if (a.isNone) return String(assetId);
  const sym = a.unwrap().symbol;
  return sym.isSome ? u8aToString(sym.unwrap().toU8a(true)) : String(assetId);
}

export interface Debt {
  reserveId: number;
  symbol: string;
  amount: BigNumber;
  usd: number;
}

export interface Market {
  account: Account;       // positions = every active, routable reserve (balance 0 if not held)
  debts: Debt[];
  chainHf: number;
  frozen: Set<number>;    // reserves that cannot receive new supply
}

const RAY = new BigNumber(10).pow(27);

/**
 * Read the whole money market for one user: every reserve the router can
 * reach through an aToken (held or not), its risk parameters and oracle price,
 * the user's balances, collateral flags and debt.
 */
export async function loadMarket(chain: Chain, who: Who): Promise<Market> {
  const aave = chain.sdk.api.aave;
  const [summary, [reserves], [userReserves], aTokens] = await Promise.all([
    aave.getSummary(who.evm),
    aave.client.getReservesData(),
    aave.client.getUserReservesData(who.evm),
    aTokenMap(chain.api),
  ]);
  const cfg = new Map(reserves.map((r) => [r.underlyingAsset.toLowerCase(), r]));
  const userCfg = new Map(userReserves.map((u) => [u.underlyingAsset.toLowerCase(), u]));

  const positions: Position[] = [];
  const debts: Debt[] = [];
  const frozen = new Set<number>();
  for (const r of summary.reserves) {
    if (r.reserveId == null) continue;
    const c = cfg.get(r.reserveAsset.toLowerCase());
    const aTokenId = aTokens.get(r.reserveId);
    if (!c || !c.isActive || c.isPaused || aTokenId == null) continue;
    const symbol = await symbolOf(chain.api, r.reserveId);
    const priceUsd = new BigNumber(r.priceInRef).shiftedBy(-BASE_DECIMALS).toNumber();
    if (c.isFrozen) frozen.add(r.reserveId);
    positions.push({
      reserveId: r.reserveId,
      aTokenId,
      symbol,
      decimals: r.decimals,
      balance: new BigNumber(r.aTokenBalance).shiftedBy(-r.decimals),
      priceUsd,
      liqThreshold: r.reserveLiquidationThreshold.toNumber(),
      ltv: Number(c.baseLTVasCollateral) / 10_000,
      isCollateral: r.isCollateral,
    });
    const u = userCfg.get(r.reserveAsset.toLowerCase());
    if (u && u.scaledVariableDebt > 0n) {
      const amount = new BigNumber(u.scaledVariableDebt.toString())
        .times(c.variableBorrowIndex.toString())
        .div(RAY)
        .shiftedBy(-r.decimals);
      debts.push({ reserveId: r.reserveId, symbol, amount, usd: amount.toNumber() * priceUsd });
    }
  }
  const debtUsd = new BigNumber(summary.totalDebt).shiftedBy(-BASE_DECIMALS).toNumber();
  return { account: { positions, debtUsd }, debts, chainHf: summary.healthFactor, frozen };
}
