import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import {
  TOKENS,
  SCAN_INTERVAL_SEC,
  WNATIVE,
  CHAINS,
  USDC,
  ARB_THRESHOLD_PCT,
  type TokenConfig,
  type CrossChainPath,
} from "./config.js";
import {
  getCexTickers,
  getCurrencies,
  getCandles,
  getGasPrice,
} from "./api.js";
import {
  scanDexPrices,
  findCrossChainArbs,
  findDexCexArbs,
  validateOpp,
  evaluateCrossChainPath,
  type ArbOpportunity,
  type DexPrice,
} from "./scanner.js";
import { saveHistory, loadHistory } from "./history.js";

const app = express();
app.use(express.json());
const PORT = parseInt(process.env.PORT || "3000");
const INTERVAL_MS = SCAN_INTERVAL_SEC * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Custom tokens persistence ----

const DATA_DIR = "data";
const CUSTOM_TOKENS_FILE = path.join(DATA_DIR, "custom-tokens.json");

function loadCustomTokens(): TokenConfig[] {
  try {
    if (fs.existsSync(CUSTOM_TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(CUSTOM_TOKENS_FILE, "utf-8"));
    }
  } catch {
    // corrupted, start fresh
  }
  return [];
}

function saveCustomTokens(tokens: TokenConfig[]): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CUSTOM_TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

let customTokens: TokenConfig[] = loadCustomTokens();

// ---- Cross-chain paths persistence ----

const CC_PATHS_FILE = path.join(DATA_DIR, "cross-chain-paths.json");

function loadCrossChainPaths(): CrossChainPath[] {
  try {
    if (fs.existsSync(CC_PATHS_FILE)) {
      return JSON.parse(fs.readFileSync(CC_PATHS_FILE, "utf-8"));
    }
  } catch {
    // corrupted, start fresh
  }
  return [];
}

function saveCrossChainPaths(paths: CrossChainPath[]): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CC_PATHS_FILE, JSON.stringify(paths, null, 2));
}

let crossChainPaths: CrossChainPath[] = loadCrossChainPaths();

function getAllTokens(): TokenConfig[] {
  return [...TOKENS, ...customTokens].filter(
    (t) => Object.keys(t.chains).length > 0,
  );
}

interface PriceEntry {
  chain: string;
  chainIndex: string;
  address: string;
  price: number;
}

interface ScanResult {
  timestamp: string;
  scanning: boolean;
  tokens: string[];
  dexPrices: Record<string, PriceEntry[]>;
  cexPrices: Record<string, number>;
  opportunities: ArbOpportunity[];
  summary: {
    total: number;
    validated: number;
    blocked: number;
    failed: number;
  };
}

let current: ScanResult = {
  timestamp: "",
  scanning: true,
  tokens: [],
  dexPrices: {},
  cexPrices: {},
  opportunities: [],
  summary: { total: 0, validated: 0, blocked: 0, failed: 0 },
};

let history: ScanResult[] = loadHistory() as ScanResult[];

// ---- API ----

app.get("/api/status", (_req, res) => res.json(current));
app.get("/api/history", (_req, res) => res.json(history.slice(-100)));

// Available chains for custom token form
app.get("/api/chains", (_req, res) => res.json(CHAINS));

// Custom token CRUD
app.get("/api/custom-tokens", (_req, res) => res.json(customTokens));

app.post("/api/custom-tokens", (req, res) => {
  const { symbol, cexInstId, chains: chainEntries } = req.body;
  if (
    !symbol ||
    !cexInstId ||
    !chainEntries ||
    typeof chainEntries !== "object"
  ) {
    res
      .status(400)
      .json({ error: "Missing required fields: symbol, cexInstId, chains" });
    return;
  }

  // Build chains record
  const chains: Record<
    string,
    { address: string; decimals: number; scanAmount: string }
  > = {};
  for (const entry of chainEntries) {
    if (
      !entry.chainIndex ||
      !entry.address ||
      !entry.decimals ||
      !entry.scanAmount
    )
      continue;
    chains[entry.chainIndex] = {
      address: entry.address.toLowerCase(),
      decimals: parseInt(entry.decimals),
      scanAmount: entry.scanAmount,
    };
  }

  if (Object.keys(chains).length === 0) {
    res.status(400).json({ error: "At least one valid chain entry required" });
    return;
  }

  // Check for duplicate symbol
  const existingIdx = customTokens.findIndex(
    (t) => t.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  const token: TokenConfig = {
    symbol: symbol.toUpperCase(),
    cexInstId,
    chains,
  };

  if (existingIdx >= 0) {
    customTokens[existingIdx] = token;
  } else {
    customTokens.push(token);
  }

  saveCustomTokens(customTokens);
  res.json({ ok: true, token });
});

app.delete("/api/custom-tokens/:symbol", (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const before = customTokens.length;
  customTokens = customTokens.filter((t) => t.symbol.toUpperCase() !== sym);
  if (customTokens.length < before) {
    saveCustomTokens(customTokens);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Token not found" });
  }
});

// Cross-chain path CRUD
app.get("/api/cross-chain-paths", (_req, res) => res.json(crossChainPaths));

app.post("/api/cross-chain-paths", (req, res) => {
  const p = req.body as Partial<CrossChainPath>;
  if (
    !p.fromChainIndex ||
    !p.toChainIndex ||
    !p.fromTokenAddress ||
    !p.toTokenAddress ||
    !p.amount
  ) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const fromChainName =
    CHAINS.find((c) => c.chainIndex === p.fromChainIndex)?.name ||
    p.fromChainIndex;
  const toChainName =
    CHAINS.find((c) => c.chainIndex === p.toChainIndex)?.name || p.toChainIndex;

  const newPath: CrossChainPath = {
    id,
    label:
      p.label ||
      `${p.fromTokenSymbol || "?"}@${fromChainName}→${p.toTokenSymbol || "?"}@${toChainName}`,
    fromChainIndex: p.fromChainIndex,
    toChainIndex: p.toChainIndex,
    fromTokenAddress: p.fromTokenAddress.toLowerCase(),
    fromTokenDecimals: p.fromTokenDecimals ?? 6,
    fromTokenSymbol: p.fromTokenSymbol || "USDC",
    toTokenAddress: p.toTokenAddress.toLowerCase(),
    toTokenDecimals: p.toTokenDecimals ?? 18,
    toTokenSymbol: p.toTokenSymbol || "TOKEN",
    sellTokenAddress: (
      p.sellTokenAddress ||
      USDC[p.toChainIndex!] ||
      ""
    ).toLowerCase(),
    sellTokenDecimals: p.sellTokenDecimals ?? 6,
    sellTokenSymbol: p.sellTokenSymbol || "USDC",
    amount: p.amount,
    enabled: p.enabled !== false,
  };

  crossChainPaths.push(newPath);
  saveCrossChainPaths(crossChainPaths);
  res.json({ ok: true, path: newPath });
});

app.delete("/api/cross-chain-paths/:id", (req, res) => {
  const before = crossChainPaths.length;
  crossChainPaths = crossChainPaths.filter((p) => p.id !== req.params.id);
  if (crossChainPaths.length < before) {
    saveCrossChainPaths(crossChainPaths);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Path not found" });
  }
});

app.patch("/api/cross-chain-paths/:id", (req, res) => {
  const p = crossChainPaths.find((p) => p.id === req.params.id);
  if (!p) {
    res.status(404).json({ error: "Path not found" });
    return;
  }
  if (typeof req.body.enabled === "boolean") {
    p.enabled = req.body.enabled;
  }
  if (typeof req.body.label === "string") {
    p.label = req.body.label;
  }
  saveCrossChainPaths(crossChainPaths);
  res.json({ ok: true, path: p });
});

app.get("/api/candles", async (req, res) => {
  const chainIndex = req.query.chainIndex as string;
  let address = (req.query.address as string) || "";
  const bar = (req.query.bar as string) || "1H";
  const limit = parseInt(req.query.limit as string) || 100;

  if (!chainIndex || !address) {
    res.json([]);
    return;
  }

  // Native token (0xeee...) → use wrapped version for K-line data
  if (address.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
    address = WNATIVE[chainIndex] || address;
  }

  const candles = await getCandles(chainIndex, address, bar, limit);
  res.json(candles);
});

app.use(express.static("public"));

// ---- Scan Logic ----

async function runScan(): Promise<void> {
  current = { ...current, scanning: true };
  console.log(`\n[${new Date().toISOString()}] Scan started...`);

  const tokens = getAllTokens();
  const [tickers, currencies] = await Promise.all([
    getCexTickers(),
    getCurrencies(),
  ]);

  // Fetch gas prices for all chains
  const chainIds = [...new Set(tokens.flatMap((t) => Object.keys(t.chains)))];
  const gasPrices = new Map<string, number>();
  for (const ci of chainIds) {
    const gp = await getGasPrice(ci);
    if (gp > 0) gasPrices.set(ci, gp);
    await sleep(1500);
  }
  console.log(
    `  Gas prices: ${chainIds.map((ci) => `${ci}=${gasPrices.get(ci) || 0}`).join(", ")}`,
  );

  const allOpps: ArbOpportunity[] = [];
  const dexPrices: Record<string, PriceEntry[]> = {};
  const cexPrices: Record<string, number> = {};
  const dexPricesFull = new Map<string, DexPrice[]>();

  // CEX prices
  for (const t of tokens) {
    const tk = tickers.get(t.cexInstId);
    if (tk) cexPrices[t.symbol] = parseFloat(tk.last);
  }

  // DEX prices
  for (const token of tokens) {
    const prices = await scanDexPrices(token);
    if (prices.length > 0) {
      dexPrices[token.symbol] = prices.map((p) => ({
        chain: p.chainName,
        chainIndex: p.chainIndex,
        address: token.chains[p.chainIndex].address,
        price: p.price,
      }));
      dexPricesFull.set(token.symbol, prices);
      allOpps.push(
        ...findCrossChainArbs(token, prices),
        ...findDexCexArbs(token, prices, tickers, currencies),
      );
    }
    await sleep(1100);
  }

  // Validate
  for (const opp of allOpps) {
    const token = tokens.find((t) => t.symbol === opp.token)!;
    const prices = dexPricesFull.get(opp.token) || [];
    await validateOpp(opp, token, prices, currencies, tickers, gasPrices);
  }

  // Evaluate cross-chain paths
  const enabledPaths = crossChainPaths.filter((p) => p.enabled);
  if (enabledPaths.length > 0) {
    console.log(`  Evaluating ${enabledPaths.length} cross-chain paths...`);
    for (const ccPath of enabledPaths) {
      const opp = await evaluateCrossChainPath(ccPath, tickers);
      if (opp) allOpps.push(opp);
    }
  }

  // Count summary (real opportunities only, before near-miss entries)
  const passed = allOpps.filter((o) => o.validated);
  const blocked = allOpps.filter(
    (o) => !o.validated && o.detail.includes("BLOCKED"),
  );
  const failed = allOpps.filter(
    (o) => !o.validated && !o.detail.includes("BLOCKED"),
  );

  // Generate near-miss entries for tokens with no arb opportunities
  for (const token of tokens) {
    if (allOpps.some((o) => o.token === token.symbol)) continue;
    const prices = dexPricesFull.get(token.symbol);
    if (!prices || prices.length === 0) continue;

    let maxSpread = 0;
    let buyChain = "",
      sellChain = "";
    let buyPrice = 0,
      sellPrice = 0;
    let bestType: "cross-chain" | "dex-cex" = "cross-chain";

    // Cross-chain spreads
    for (let i = 0; i < prices.length; i++) {
      for (let j = i + 1; j < prices.length; j++) {
        const lo = Math.min(prices[i].price, prices[j].price);
        const hi = Math.max(prices[i].price, prices[j].price);
        const spread = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
        if (spread > maxSpread) {
          maxSpread = spread;
          const [buy, sell] =
            prices[i].price < prices[j].price
              ? [prices[i], prices[j]]
              : [prices[j], prices[i]];
          buyChain = buy.chainName;
          buyPrice = buy.price;
          sellChain = sell.chainName;
          sellPrice = sell.price;
          bestType = "cross-chain";
        }
      }
    }

    // DEX-CEX spreads
    const cexP = cexPrices[token.symbol];
    if (cexP > 0) {
      for (const p of prices) {
        const spread = Math.abs((p.price - cexP) / cexP) * 100;
        if (spread > maxSpread) {
          maxSpread = spread;
          if (p.price > cexP) {
            buyChain = "CEX";
            buyPrice = cexP;
            sellChain = `DEX(${p.chainName})`;
            sellPrice = p.price;
          } else {
            buyChain = `DEX(${p.chainName})`;
            buyPrice = p.price;
            sellChain = "CEX";
            sellPrice = cexP;
          }
          bestType = "dex-cex";
        }
      }
    }

    if (maxSpread > 0) {
      allOpps.push({
        type: bestType,
        token: token.symbol,
        buyAt: buyChain,
        buyPrice,
        sellAt: sellChain,
        sellPrice,
        spreadPct: maxSpread,
        canDeposit: true,
        canWithdraw: true,
        dwUnknown: false,
        validated: false,
        detail: `NO_ARB: best spread ${maxSpread.toFixed(2)}% < ${ARB_THRESHOLD_PCT}% threshold`,
        netProfitUsd: 0,
        netProfitPct: 0,
        gasCostUsd: 0,
        slippageCostUsd: 0,
        bridgeFeeUsd: 0,
      });
    }
  }

  current = {
    timestamp: new Date().toISOString(),
    scanning: false,
    tokens: tokens.map((t) => t.symbol),
    dexPrices,
    cexPrices,
    opportunities: allOpps,
    summary: {
      total: allOpps.length,
      validated: passed.length,
      blocked: blocked.length,
      failed: failed.length,
    },
  };

  history.push(current);
  if (history.length > 500) history = history.slice(-500);
  saveHistory(history);

  console.log(
    `[${current.timestamp}] Done: ${passed.length} valid | ${blocked.length} blocked | ${failed.length} failed`,
  );
}

async function scanLoop(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runScan();
    } catch (err) {
      console.error("Scan error:", err);
      current = { ...current, scanning: false };
    }
    await sleep(INTERVAL_MS);
  }
}

// ---- Start ----

app.listen(PORT, () => {
  console.log(`\n  OKX-Claw Dashboard : http://localhost:${PORT}`);
  console.log(`  Scan interval      : ${SCAN_INTERVAL_SEC}s\n`);
  scanLoop();
});
