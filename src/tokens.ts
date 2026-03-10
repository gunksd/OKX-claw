import type { TokenConfig } from "./config.js";

// ───── Helpers ─────
const N = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // native token
type C = { address: string; decimals: number; scanAmount: string };
const c = (a: string, d: number, s: string): C => ({
  address: a,
  decimals: d,
  scanAmount: s,
});

// Scan amounts (in smallest token unit)
// Use amounts that represent ~$100-500 worth for meaningful price discovery
const W01 = "100000000000000000"; // 0.1 ETH (~$200)
const W1 = "1000000000000000000"; // 1 token (18-dec)
const W10 = "10000000000000000000"; // 10 tokens (18-dec)
const W50 = "50000000000000000000"; // 50 tokens (18-dec)
const W500 = "500000000000000000000"; // 500 tokens (18-dec)

// ═══════════════════════════════════════════════════════════════
//  TOKEN LIST — High-liquidity mainstream tokens only
//  Focus on tokens with deep DEX liquidity across multiple chains
//  Users can add more via dashboard
//  Chains: ETH(1) BSC(56) Arbitrum(42161) Polygon(137)
//          Base(8453) Optimism(10) Avalanche(43114)
// ═══════════════════════════════════════════════════════════════

export const TOKENS: TokenConfig[] = [
  // ───────────── ETH — deepest liquidity everywhere ─────────────
  {
    symbol: "ETH",
    cexInstId: "ETH-USDT",
    chains: {
      "1": c(N, 18, W01),
      "42161": c(N, 18, W01),
      "8453": c(N, 18, W01),
      "10": c(N, 18, W01),
      "56": c("0x2170ed0880ac9a755fd29b2688956bd959f933f8", 18, W01),
      "137": c("0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", 18, W01),
    },
  },

  // ───────────── WBTC — deep liquidity, high value ─────────────
  {
    symbol: "WBTC",
    cexInstId: "BTC-USDT",
    chains: {
      "1": c("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", 8, "1000000"), // 0.01 BTC
      "42161": c("0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", 8, "1000000"),
      "137": c("0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", 8, "1000000"),
      "10": c("0x68f180fcce6836688e9084f035309e29bf0a2095", 8, "1000000"),
    },
  },

  // ───────────── LINK — strong liquidity across chains ─────────────
  {
    symbol: "LINK",
    cexInstId: "LINK-USDT",
    chains: {
      "1": c("0x514910771af9ca656af840dff83e8264ecf986ca", 18, W50),
      "42161": c("0xf97f4df75117a78c1a5a0dbb814af92458539fb4", 18, W50),
      "137": c("0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", 18, W50),
      "10": c("0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6", 18, W50),
      "56": c("0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd", 18, W50),
      "43114": c("0x5947bb275c521040051d82396e4b9d3f8eb1ee04", 18, W50),
    },
  },

  // ───────────── UNI — good liquidity on major chains ─────────────
  {
    symbol: "UNI",
    cexInstId: "UNI-USDT",
    chains: {
      "1": c("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", 18, W50),
      "42161": c("0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0", 18, W50),
      "137": c("0xb33eaad8d922b1083446dc23f610c2567fb5180f", 18, W50),
      "10": c("0x6fd9d7ad17242c41f7131d257212c54a0e816691", 18, W50),
    },
  },

  // ───────────── AAVE — deep DeFi liquidity ─────────────
  {
    symbol: "AAVE",
    cexInstId: "AAVE-USDT",
    chains: {
      "1": c("0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", 18, W1),
      "42161": c("0xba5ddd1f9d7f570dc94a51479a000e3bce967196", 18, W1),
      "137": c("0xd6df932a45c0f255f85145f286ea0b292b21c90b", 18, W1),
      "10": c("0x76fb31fb4af56892a25e32cfc43de717950c9278", 18, W1),
      "43114": c("0x63a72806098bd3d9520cc43356dd78afe5d386d9", 18, W1),
    },
  },

  // ───────────── CRV — deep liquidity via Curve pools ─────────────
  {
    symbol: "CRV",
    cexInstId: "CRV-USDT",
    chains: {
      "1": c("0xd533a949740bb3306d119cc777fa900ba034cd52", 18, W500),
      "42161": c("0x11cdb42b0eb46d95f990bedd4695a6e3fa034978", 18, W500),
      "137": c("0x172370d5cd63279efa6d502dab29171933a610af", 18, W500),
    },
  },
];
