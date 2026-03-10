export const WEB3_BASE_URL = "https://web3.okx.com";
export const CEX_BASE_URL = "https://www.okx.com";

// Initial spread threshold: skip opportunities below this gross % (saves API calls)
export const ARB_THRESHOLD_PCT = 3;

// Minimum net profit PERCENTAGE after all costs (gas + slippage + bridge)
// e.g. 5 means: $1000 buy → net profit must exceed $50 (5%) to qualify
export const MIN_NET_PROFIT_PCT = 5;

// Trade size (USD) used for net profit calculation
export const TRADE_SIZE_USD = 1000;

export interface ChainConfig {
  name: string;
  chainIndex: string;
}

export const CHAINS: ChainConfig[] = [
  { name: "Ethereum", chainIndex: "1" },
  { name: "BSC", chainIndex: "56" },
  { name: "Arbitrum", chainIndex: "42161" },
  { name: "Base", chainIndex: "8453" },
  { name: "Polygon", chainIndex: "137" },
  { name: "Optimism", chainIndex: "10" },
  { name: "Avalanche", chainIndex: "43114" },
];

// USDC address per chain (used as quote token for price discovery)
export const USDC: Record<string, string> = {
  "1": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "56": "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  "42161": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  "137": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  "8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "10": "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  "43114": "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
};

export interface TokenConfig {
  symbol: string;
  cexInstId: string;
  // chainIndex -> { address, decimals, scanAmount (minimal units) }
  chains: Record<
    string,
    { address: string; decimals: number; scanAmount: string }
  >;
}

// ~10 mainstream tokens from tokens.ts
export { TOKENS } from "./tokens.js";

// Scan interval for continuous monitoring (seconds)
export const SCAN_INTERVAL_SEC = parseInt(
  process.env.SCAN_INTERVAL || "120",
  10,
);

// Bridge cost fallback (USD) — only used when real CEX withdrawal fee data is unavailable
export function estimateBridgeCostUsd(
  fromChain: string,
  toChain: string,
): number {
  if (fromChain === toChain) return 0;
  const isL1 = (c: string) => c === "1"; // Ethereum mainnet
  if (isL1(fromChain) || isL1(toChain)) return 8; // L1 involved ~$8
  return 3; // L2-L2 ~$3
}

// Native token of each chain (for gas fee conversion to USD)
export const CHAIN_NATIVE: Record<string, { symbol: string; cexPair: string }> =
  {
    "1": { symbol: "ETH", cexPair: "ETH-USDT" },
    "56": { symbol: "BNB", cexPair: "BNB-USDT" },
    "42161": { symbol: "ETH", cexPair: "ETH-USDT" },
    "137": { symbol: "POL", cexPair: "POL-USDT" },
    "8453": { symbol: "ETH", cexPair: "ETH-USDT" },
    "10": { symbol: "ETH", cexPair: "ETH-USDT" },
    "43114": { symbol: "AVAX", cexPair: "AVAX-USDT" },
  };

// WETH / wrapped native address per chain (for K-line lookup when token is native)
export const WNATIVE: Record<string, string> = {
  "1": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "56": "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  "42161": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH Arbitrum
  "137": "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC (POL)
  "8453": "0x4200000000000000000000000000000000000006", // WETH Base
  "10": "0x4200000000000000000000000000000000000006", // WETH Optimism
  "43114": "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", // WAVAX
};

// OKX CEX chain label -> chainIndex mapping (for deposit/withdraw status)
export const CEX_CHAIN_MAP: Record<string, string> = {
  ERC20: "1",
  Ethereum: "1",
  BSC: "56",
  BEP20: "56",
  "Arbitrum One": "42161",
  Polygon: "137",
  Base: "8453",
  Optimism: "10",
  "Avalanche C-Chain": "43114",
  AVAXC: "43114",
};

// Cross-chain path for triangle arbitrage:
// USDC(ChainA) --cross-chain--> Token(ChainB) --DEX sell--> USDC(ChainB)
export interface CrossChainPath {
  id: string;
  label: string;
  fromChainIndex: string;
  toChainIndex: string;
  fromTokenAddress: string;
  fromTokenDecimals: number;
  fromTokenSymbol: string;
  toTokenAddress: string;
  toTokenDecimals: number;
  toTokenSymbol: string;
  sellTokenAddress: string; // usually USDC on dest chain
  sellTokenDecimals: number;
  sellTokenSymbol: string;
  amount: string; // in smallest unit
  enabled: boolean;
}
