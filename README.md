# OKX-Claw

Cross-chain & DEX-CEX arbitrage scanner with real-time web dashboard.

Scans token prices across 7 EVM chains via OKX DEX Aggregator, compares with OKX CEX spot prices, and identifies profitable arbitrage opportunities — accounting for gas, bridge fees, and deposit/withdraw availability.

## Features

- **Cross-chain arbitrage** — detects price differences for the same token across different chains
- **DEX-CEX arbitrage** — compares on-chain DEX prices with OKX centralized exchange
- **Cross-chain path (triangle arb)** — user-defined paths like USDC@Arb → TOKEN@Avax → sell USDC, via LI.FI bridge + DEX sell
- **Effective price calculation** — prices computed from actual swap amounts (`toTokenAmount / fromTokenAmount`), not oracle reference prices
- **Dual-side validation** — re-quotes both buy AND sell sides at 5× volume to stress-test liquidity
- **Bridge cost estimation** — real bridge fees from OKX Cross-chain API, LI.FI fallback, hardcoded last resort
- **Deposit/Withdraw check** — filters out opportunities where CEX deposit or withdrawal is suspended
- **Transaction simulation** — optional dry-run via OKX simulate API (requires wallet address)
- **Custom tokens** — add/remove tokens via dashboard, persisted to `data/custom-tokens.json`
- **K-line charts** — click any token price to view candlestick chart (1H/4H/1D)
- **Web dashboard** — OKX-styled dark theme UI with auto-refresh, i18n (zh/en), history
- **Continuous monitoring** — configurable scan interval with persistent history

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your OKX API credentials

# 3a. Run single scan (CLI)
npm run scan

# 3b. Start web dashboard
npm run dev
# Open http://localhost:3000
```

## Environment Variables

```env
# OKX Web3 API (required)
OKX_API_KEY=your_api_key
OKX_SECRET_KEY=your_secret_key
OKX_PASSPHRASE=your_passphrase
OKX_PROJECT_ID=your_project_id

# OKX CEX API (optional — falls back to Web3 keys)
OKX_CEX_API_KEY=
OKX_CEX_SECRET_KEY=
OKX_CEX_PASSPHRASE=

# Optional
EVM_WALLET_ADDRESS=0x...     # Enable tx simulation
PORT=3000                     # Dashboard port
SCAN_INTERVAL=120             # Seconds between scans
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run scan` | Single CLI scan, prints results to terminal |
| `npm run dev` | Start web dashboard with continuous monitoring |
| `npm run dashboard` | Alias for `npm run dev` |

## Architecture

```
src/
  config.ts    — Chains, thresholds, bridge cost config, type definitions
  tokens.ts    — Built-in token list (ETH, WBTC, LINK, UNI, AAVE, CRV)
  api.ts       — OKX DEX Aggregator (v6), CEX (v5), Cross-chain (v5), LI.FI API clients
  scanner.ts   — Price scanning, arb detection, dual-side validation, cross-chain path evaluation
  server.ts    — Express server, scan loop, REST API, custom token/path CRUD
  history.ts   — Scan history persistence (data/history.json)
  index.ts     — CLI entry point

public/
  index.html   — Web dashboard (single-page, OKX dark theme, i18n)

data/              (auto-created at runtime)
  history.json          — Scan history
  custom-tokens.json    — User-added tokens
  cross-chain-paths.json — User-defined cross-chain paths
```

## How It Works

1. **Fetch CEX data** — spot tickers + deposit/withdraw status from OKX v5 API
2. **Fetch gas prices** — per-chain gas price via OKX v6 gas-price API
3. **Scan DEX prices** — quote each token on each chain via OKX DEX Aggregator v6, calculate effective price from actual swap amounts
4. **Detect opportunities** — compare all price pairs (chain×chain and DEX×CEX), filter by threshold
5. **Dual-side validation** — re-quote BOTH buy and sell sides at 5× amount, check price impact, recalculate spread with validated prices
6. **Evaluate cross-chain paths** — LI.FI bridge quote → DEX sell quote → profit calculation
7. **Simulate** (optional) — dry-run the swap transaction on-chain
8. **Report** — display in terminal (CLI) or web dashboard

### Price Calculation

Prices are calculated from **actual swap amounts**, not oracle reference prices:

```
effectivePrice = (toTokenAmount / 10^toDecimals) / (fromTokenAmount / 10^fromDecimals)
```

This ensures prices reflect real DEX liquidity on each chain.

### Profit Calculation

```
Net Profit = (Spread% × TradeSize) − Gas − Bridge Fee
```

- **Spread**: price difference between validated buy and sell venues
- **Gas**: estimated from DEX quote, converted to USD via native token price
- **Bridge Fee**: real fees from OKX/LI.FI APIs, with hardcoded fallback ($8 L1↔L2, $3 L2↔L2)
- Minimum net profit threshold: configurable (default 5% of trade size)

## Built-in Tokens

| Token | CEX Pair | Chains |
|-------|----------|--------|
| ETH | ETH-USDT | Ethereum, BSC, Arbitrum, Polygon, Base, Optimism |
| WBTC | BTC-USDT | Ethereum, Arbitrum, Polygon, Optimism |
| LINK | LINK-USDT | Ethereum, BSC, Arbitrum, Polygon, Avalanche, Optimism |
| UNI | UNI-USDT | Ethereum, Arbitrum, Polygon, Optimism |
| AAVE | AAVE-USDT | Ethereum, Arbitrum, Polygon, Optimism, Avalanche |
| CRV | CRV-USDT | Ethereum, Arbitrum, Polygon |

Additional tokens can be added via the dashboard or `data/custom-tokens.json`.

## Dashboard API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Current scan result + scanning state |
| `/api/history` | GET | Last 100 scan results |
| `/api/chains` | GET | Available chains for token config |
| `/api/custom-tokens` | GET | List custom tokens |
| `/api/custom-tokens` | POST | Add/update custom token |
| `/api/custom-tokens/:symbol` | DELETE | Remove custom token |
| `/api/cross-chain-paths` | GET | List cross-chain paths |
| `/api/cross-chain-paths` | POST | Add cross-chain path |
| `/api/cross-chain-paths/:id` | PATCH | Toggle enable/disable, rename |
| `/api/cross-chain-paths/:id` | DELETE | Remove cross-chain path |
| `/api/candles` | GET | K-line candle data for chart |

## Configuration

Edit `src/config.ts` to adjust:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ARB_THRESHOLD_PCT` | 3% | Minimum gross spread to trigger validation |
| `MIN_NET_PROFIT_PCT` | 5% | Minimum net profit after all costs |
| `TRADE_SIZE_USD` | $1000 | Simulated trade size for profit calculation |
| `SCAN_INTERVAL_SEC` | 120s | Seconds between scan cycles |

## Tech Stack

- **Runtime**: Node.js + TypeScript (tsx)
- **Backend**: Express.js
- **APIs**: OKX DEX Aggregator v6, OKX CEX v5, OKX Cross-chain v5, LI.FI Bridge
- **Frontend**: Vanilla HTML/JS, OKX dark theme, lightweight-charts (K-line)
- **Storage**: JSON file persistence (no database required)

## License

MIT
