# hydration-rebalancer

Brings the collateral of a Hydration money-market position back to equal weights in one atomic `utility.batchAll`, which you then sign on a Ledger. The loan is left alone. The tool reads the chain, plans and dry-runs the batch, and prints the encoded call. It never sees a private key and never submits anything.

Example: BTC rallies and the collateral goes from $13K / $10K / $10K (tBTC / ETH / HYPE) to $11K each. That is two buys in one batch: aETH and aHYPE, each paid for with atBTC.

## How the swap works

Hydration registers every money-market aToken as a Substrate asset (atBTC = 1006, aETH = 1007, aHYPE = 1010). The router also has an `Aave` pool type, a 1:1 hop between a reserve and its aToken that calls `Pool.withdraw` or `Pool.supply` for the account doing the trade. A single

```
router.buy(asset_in = atBTC, asset_out = aHYPE, amount_out, max_amount_in, route)
route = Aave(atBTC→tBTC) · Omnipool(tBTC→HYPE) · Aave(HYPE→aHYPE)
```

therefore withdraws tBTC collateral, swaps it, and supplies HYPE as collateral, all inside one call. Hydration's own swap page uses the same mechanism. This replaces the withdraw → buy → supply triple from the original plan: the amount supplied is exactly `amount_out`, with nothing left over in the wallet, and `max_amount_in` is the slippage guard. Each buy is wrapped in `dispatcher.dispatch_with_extra_gas(call, 1_000_000)`, the same wrapper the Hydration SDK adds for accounts that have debt. Without it the Aave EVM calls run out of gas.

Routes come from `@galacticcouncil/sdk`'s `TradeRouter`. On 2026-10-30 (runtime `hydradx` 455) it found routes for every pair of tBTC (1000765), ETH (34) and HYPE (1001355). ETH is not in the Omnipool, so ETH legs go through the GETH stable pool (`Stableswap 4200 ↔ Aave 420`).

| Reserve | Underlying id | aToken id | LTV / LT | Notes |
|---|---|---|---|---|
| tBTC | 1000765 | 1006 | 80% / 85% | default BTC |
| ETH | 34 | 1007 | 75% / 85% | |
| HYPE | 1001355 | 1010 | 70% / 75% | listed as collateral |
| WBTC (Wormhole) | 19 | 1004 | 0 | frozen, no route; not supported |

Money-market Pool proxy: `0x1b02E051683b5cfaC5929C25E84adb26ECf87B38`. Prices and the health factor come from the SDK's `UiPoolDataProvider` read (`0x112b087b60C1a166130d59266363C45F8aa99db0`), which uses the Aave oracle prices in 8-decimal USD.

## Install

```bash
cd ~/Documents/hydration-rebalancer && npm install && npm run build
```

Node 22 or later. On stderr you will see `@polkadot/util has multiple versions` warnings. The SDK is CJS-only and this CLI is ESM, so both builds of the same version get loaded. They are harmless.

## ローカル UI（Talisman）

```bash
npm run build && npm run ui
```

`http://127.0.0.1:5180` を、Talisman を入れたブラウザで開く。サーバーは `127.0.0.1` だけで待ち受ける。鍵は持たず、自分では何も送信しない。使い終わったら Ctrl+C で止める。

1. 「Talisman に接続」でアカウントを選ぶ。アドレスを貼り付けると、読み取り専用で開く。
2. 担保にしている資産が表に並ぶ。目標の比率はスライダーで決める。% の欄に数字を入れると、その資産の比率を固定して、残りを今の比で分け直す。「均等にする」「現在の比率に戻す」のボタンもある。「＋ 資産を追加」からは、まだ持っていない資産も選べる（LTV が 0 のものと凍結中のものは除く）。対象から外した担保は動かさないが、HF の計算には入れる。比率を 0 にすると、その資産を売り切る（端数は少し残る）。
3. リスク表には「現在」「目標（概算）」「見積もり後」の3列が並ぶ。比べるのは HF、平均 LT、借入枠の使用率、全担保が一律に下がったときに清算までの下落率、各資産が単独で下がったときの清算までの下落率。概算は oracle 価格で手数料なしの計算、見積もり後は実際のルートの見積もり（手数料とインパクト込み）。下落率の計算は、借入がステーブルである前提。そうでない借入があれば注意を出す。
4. 「見積もり＋dry-run」を押すと、サーバーが最新の残高で計画を作り直す。そのうえで見積もり、HF の段階チェック、チャンク分割、インパクトのチェックをかけ、チェーンの `DryRunApi` で一括実行を試す。問題があれば赤い枠で出る。
5. 問題がなく、見積もりから 60 秒以内なら「Talisman で署名して送信」を押せる。ブラウザは受け取った call を自分でデコードし、次の点をすべて確かめてから Talisman に渡す（`src/core/verify.ts`）。1 つでも外れたら署名を中止する。
   - 外側が `utility.batchAll` で、中身がすべて `dispatcher.dispatchWithExtraGas(router.buy)` であること。送金など、ほかの call は入れさせない。
   - 各スワップの資産、受け取る量、払う上限が、画面の見積もりと 1 件ずつ一致すること。スワップの数も一致すること。
   - ルートが、売る aToken から始まって買う aToken で終わり、途中でつながっていること。
   - 払う上限が oracle 価格から見て、インパクト上限＋スリッページ（＋価格の揺れ 1%）を超えないこと。

   確認ダイアログの文面は、デコードした call から作る。Ledger を Talisman につないでいれば、署名は Ledger で承認する。ブロックに入ったら残高を読み直す。

   oracle 価格と資産の対応は、見積もりと一緒にローカルサーバーから受け取る。そのため、この検証が守るのは「画面に出た見積もりと、署名する中身が同じであること」。最後の砦は、Talisman と Ledger に表示される中身。

最初は「今回の上限 USD」に 10 か 20 を入れて、少額で1回通すこと。Talisman で Ledger アカウント（Polkadot generic app）を使い、`CheckMetadataHash` 付きで署名する経路は、まだ実機で試していない。

Talisman を使わない場合は、見積もり結果の「call data」を開いて、下の polkadot.js apps の手順で署名できる。

## Usage

```bash
node dist/cli.js --address <your SS58 or 0x address>
```

| Option | Default | Meaning |
|---|---|---|
| `--assets` | `1000765,34,1001355` | Reserve ids to equal-weight (tBTC, ETH, HYPE). Other collateral is left untouched but still counts toward the HF. |
| `--threshold` | `5` | Do nothing unless some weight is more than this many percentage points off `1/n`. 13K/10K/10K is 6.1 pp. |
| `--min-hf` | `1.5` | Refuse if the HF right after any withdraw step drops below this. |
| `--slippage` | `1` | `max_amount_in` = quote × (1 + slippage%). |
| `--max-impact` | `3` | Refuse a buy whose quote is this % worse than the oracle price (thin pool). |
| `--max-chunks` | `5` | How far a leg may be split to keep the HF above `--min-hf`. |
| `--max-usd` | none | Cap the total USD moved this run. Use it for the first test, e.g. `--max-usd 20`. |
| `--min-leg` | `5` | Skip legs under this many USD. |
| `--force` | off | Plan even when drift is under the threshold. |
| `--rpc` | `wss://rpc.hydradx.cloud` | Any Hydration WSS endpoint (e.g. `wss://hydration-rpc.n.dwellir.com`). |

### What a run does

1. It resolves the address to both forms (SS58 and the H160 the EVM sees) with the runtime's `EvmAccountsApi`.
2. It reads every supplied reserve, the oracle prices, the liquidation thresholds and the debt, and prints the weights plus HF from both the chain and the model, so you can see they agree.
3. It plans the legs greedily: the most overweight asset funds the most underweight one, and so on. Every leg is an exact-out buy of the underweight aToken.
4. It simulates the HF step by step. Inside one `router.buy`, Aave checks the HF when the aToken leaves the account and gives no credit for the supply at the end of the route, so the number that matters is the HF after each withdraw. If that falls below `--min-hf`, the leg is split into chunks (withdraw a part, supply it back, repeat). If 5 chunks are still not enough, the tool refuses.
5. It quotes each chunk cumulatively: chunk *i* costs quote(first *i* chunks) − quote(first *i−1*). Later chunks are therefore priced off the pool state the earlier ones leave behind. It then re-runs the HF check on the quoted worst-case inputs and checks price impact against the oracle.
6. It builds `utility.batchAll([...])` and executes it in the runtime's `DryRunApi.dry_run_call` as your signed origin. Nothing is submitted and no fee is paid. It prints `Runtime dry-run: OK` or the module error. Any failure exits with code 2.
7. It prints the estimated fee, the encoded call hex and the call hash.

Sample output against a live read-only account (tBTC + ETH, HF 2.14), capped to $20:

```
Max drift 28.45 pp (threshold 5 pp)
Capped to $20 moved this run (--max-usd)

Plan (one utility.batchAll, executed in order)
  1. router.buy 0.00024567503083582 atBTC with ≤ 0.008577741534143979 aETH (quote 0.008492813400142553, +0.21% vs oracle)
     route Stableswap:1007>4200 Aave:4200>420 Omnipool:420>1000765 Aave:1000765>1006
     HF after withdraw 2.139, after supply 2.140

Runtime dry-run: OK
Encoded call (96 bytes) — polkadot.js apps → Developer → Extrinsics → Decode:
0x0d0204280343…
```

The same account uncapped ($48K of aETH → atBTC) is refused. The second chunk would pay 15% over the oracle because the GETH route is shallow at that size. Large moves need `--max-usd` and several runs.

## Signing with Ledger

The call is built for the Polkadot generic Ledger app. Hydration's runtime has `CheckMetadataHash`, which the generic app needs in order to show the decoded call on the device.

1. Install the Polkadot app (the generic one) on the Ledger with Ledger Live and open it on the device.
2. Open polkadot.js apps on Hydration: `https://polkadot.js.org/apps/?rpc=wss://rpc.hydradx.cloud`. In Settings → General, set "manage hardware connections" to "Attach Ledger via WebUSB" and pick the Polkadot generic Ledger app type. In Accounts, add the Ledger account if it is not there yet. Its address should be the one you passed to `--address`.
3. Run the CLI right before signing. Quotes go stale, and `max_amount_in` only protects you against 1% (`--slippage`) of movement.
4. Go to Developer → Extrinsics → Decode and paste the hex. Check that the decoded call is `utility.batchAll` containing only `dispatcher.dispatchWithExtraGas(router.buy …)` entries, and that the call hash matches the one the CLI printed.
5. Pick the Ledger account and click Submit Transaction, then Sign and Submit. Read the call on the device, then approve.

If any buy fails on-chain (price moved past `max_amount_in`, HF check, pool state), `batchAll` reverts the whole batch. You pay the fee and the position stays as it was.

### First real run

Run with `--max-usd 10` (or 20), sign that, and confirm in app.hydration.net/borrow that the weights moved slightly and the debt is unchanged. Only then run without the cap.

## Limits and things to know

- The tool only swaps between reserves that are already enabled as collateral on your account. Supplying through the router's Aave hop into a reserve you hold zero of should auto-enable it, as in standard Aave v3, but that path is not used here and has not been checked.
- Your Ledger account has already used the money market through the UI, so its EVM address mapping works. The dry-run is the real check: it runs the exact calls as your origin.
- The model HF uses each reserve's base liquidation threshold. E-mode and isolation mode are not modelled. The chain HF printed next to it is the ground truth for the starting point.
- Price impact on the ETH route (GETH stable pool) is the binding limit for large legs, well before HF is.
- The CLI does not sign. Sign through the local UI (Talisman) or polkadot.js apps.

## Development

```bash
npm test
npm run dev -- --address <addr> --max-usd 20
```

`src/core/plan.ts` is pure (weights, legs to any target weights, HF simulation, chunking, risk numbers) and covered by `tests/plan.test.ts`. `src/core/verify.ts` is the pre-signing check the browser runs on the decoded call, covered by `tests/verify.test.ts`. `src/core/chain.ts` reads the market, `src/core/build.ts` quotes, builds the batch and runs the dry-run. `src/cli.ts` and `src/server.ts` (local UI API) both sit on that core. `src/web/main.ts` is the browser page, bundled by esbuild into `web/app.js`.
