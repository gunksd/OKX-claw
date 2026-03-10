import axios from "axios";
import CryptoJS from "crypto-js";
import { WEB3_BASE_URL, CEX_BASE_URL } from "./config.js";

// ============ Retry helper ============

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  baseDelay = 2000,
): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const status = e.response?.status;
      // Only retry on 5xx server errors or network errors
      if (i < retries && (!status || status >= 500)) {
        const delay = baseDelay * (i + 1); // linear backoff: 2s, 4s
        console.log(
          `    [retry ${i + 1}/${retries}] status=${status || "network"} wait ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

// ============ Auth ============

function web3Headers(method: string, requestPath: string, body: string = "") {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  const projectId = process.env.OKX_PROJECT_ID;

  if (!apiKey || !secretKey || !passphrase || !projectId) {
    throw new Error(
      "Missing env: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE, OKX_PROJECT_ID",
    );
  }

  const ts = new Date().toISOString();
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": apiKey,
    "OK-ACCESS-SIGN": CryptoJS.enc.Base64.stringify(
      CryptoJS.HmacSHA256(ts + method + requestPath + body, secretKey),
    ),
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": passphrase,
    "OK-ACCESS-PROJECT": projectId,
  };
}

function cexHeaders(method: string, requestPath: string, body: string = "") {
  const apiKey = process.env.OKX_CEX_API_KEY || process.env.OKX_API_KEY;
  const secretKey =
    process.env.OKX_CEX_SECRET_KEY || process.env.OKX_SECRET_KEY;
  const passphrase =
    process.env.OKX_CEX_PASSPHRASE || process.env.OKX_PASSPHRASE;

  if (!apiKey || !secretKey || !passphrase) {
    throw new Error(
      "Missing env: OKX_CEX_API_KEY, OKX_CEX_SECRET_KEY, OKX_CEX_PASSPHRASE",
    );
  }

  const ts = new Date().toISOString();
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": apiKey,
    "OK-ACCESS-SIGN": CryptoJS.enc.Base64.stringify(
      CryptoJS.HmacSHA256(ts + method + requestPath + body, secretKey),
    ),
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": passphrase,
  };
}

// ============ DEX Aggregator (v6) ============

export interface QuoteResult {
  toTokenAmount: string;
  fromTokenAmount: string;
  estimateGasFee: string; // gas units (smallest chain unit, e.g. wei) — NOT USD
  tradeFee: string; // estimated network fee in USD
  priceImpactPercent: string;
  fromToken: {
    tokenUnitPrice: string;
    decimal: string;
    isHoneyPot: boolean;
    taxRate: string;
  };
  toToken: { tokenUnitPrice: string; decimal: string };
}

export async function getDexQuote(
  chainIndex: string,
  fromToken: string,
  toToken: string,
  amount: string,
): Promise<QuoteResult | null> {
  try {
    const params = new URLSearchParams({
      chainIndex,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      amount,
      slippagePercent: "0.5",
    });
    const path = `/api/v6/dex/aggregator/quote`;
    const qs = "?" + params.toString();

    const res = await withRetry(() => {
      const headers = web3Headers("GET", path, qs);
      return axios.get(`${WEB3_BASE_URL}${path}${qs}`, {
        headers,
        timeout: 15000,
      });
    });

    if (res.data.code === "0" && res.data.data?.[0]) return res.data.data[0];
    return null;
  } catch (e: any) {
    const msg = e.response?.data?.msg || e.response?.data?.error || e.message;
    const code = e.response?.data?.code || "";
    console.error(`    [quote err] chain=${chainIndex} code=${code} ${msg}`);
    return null;
  }
}

export async function getSwapTx(
  chainIndex: string,
  fromToken: string,
  toToken: string,
  amount: string,
  wallet: string,
): Promise<any> {
  try {
    const params = new URLSearchParams({
      chainIndex,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      amount,
      userWalletAddress: wallet,
      slippagePercent: "0.5",
    });
    const path = `/api/v6/dex/aggregator/swap`;
    const qs = "?" + params.toString();

    const res = await withRetry(() => {
      const headers = web3Headers("GET", path, qs);
      return axios.get(`${WEB3_BASE_URL}${path}${qs}`, {
        headers,
        timeout: 15000,
      });
    });

    if (res.data.code === "0" && res.data.data?.[0]) return res.data.data[0];
    return null;
  } catch {
    return null;
  }
}

export interface SimResult {
  success: boolean;
  gasUsed: string;
  failReason: string;
}

export async function simulate(
  fromAddr: string,
  toAddr: string,
  data: string,
  chainIndex: string,
  value: string = "0",
): Promise<SimResult | null> {
  try {
    const path = `/api/v6/dex/pre-transaction/simulate`;
    const body = {
      chainIndex,
      fromAddress: fromAddr,
      toAddress: toAddr,
      txAmount: value,
      extJson: { inputData: data },
    };
    const bodyStr = JSON.stringify(body);
    const headers = web3Headers("POST", path, bodyStr);

    const res = await axios.post(`${WEB3_BASE_URL}${path}`, body, { headers });
    if (res.data.code === "0" && res.data.data?.[0]) {
      const r = res.data.data[0];
      return {
        success: !r.failReason,
        gasUsed: r.gasUsed || "0",
        failReason: r.failReason || "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ============ Cross-chain Build-TX (v5) ============
// Uses /build-tx endpoint (the only cross-chain endpoint available)
// Returns bridge fees in token units — caller must convert to USD

export interface CrossChainQuote {
  bridgeName: string;
  crossChainFee: string; // fee in token units (stablecoin or WETH)
  crossChainFeeTokenAddress: string; // contract address of fee token
  otherNativeFee: string; // additional native token fee (source chain)
  toTokenAmount: string; // amount received on destination
  gasLimit: string;
  gasPrice: string;
}

export async function getCrossChainQuote(
  fromChainId: string,
  toChainId: string,
  fromTokenAddress: string,
  toTokenAddress: string,
  amount: string,
  userWalletAddress: string,
): Promise<CrossChainQuote | null> {
  try {
    const params = new URLSearchParams({
      fromChainId,
      toChainId,
      fromTokenAddress,
      toTokenAddress,
      amount,
      slippage: "0.01", // 1%
      sort: "1", // optimal route
      userWalletAddress,
    });
    const path = `/api/v5/dex/cross-chain/build-tx`;
    const qs = "?" + params.toString();

    const res = await withRetry(() => {
      const headers = web3Headers("GET", path, qs);
      return axios.get(`${WEB3_BASE_URL}${path}${qs}`, {
        headers,
        timeout: 15000,
      });
    });

    const code = res.data.code;
    if ((code === "0" || code === 0) && res.data.data?.[0]) {
      const r = res.data.data[0];
      const router = r.router || {};
      return {
        bridgeName: router.bridgeName || "unknown",
        crossChainFee: router.crossChainFee || "0",
        crossChainFeeTokenAddress: router.crossChainFeeTokenAddress || "",
        otherNativeFee: router.otherNativeFee || "0",
        toTokenAmount: r.toTokenAmount || "0",
        gasLimit: r.tx?.gasLimit || "0",
        gasPrice: r.tx?.gasPrice || "0",
      };
    }
    console.error(
      `    [cross-chain err] ${fromChainId}->${toChainId}: code=${code} msg=${res.data.msg}`,
    );
    return null;
  } catch (e: any) {
    const msg = e.response?.data?.msg || e.response?.data?.error || e.message;
    console.error(`    [cross-chain err] ${fromChainId}->${toChainId}: ${msg}`);
    return null;
  }
}

// ============ LI.FI Bridge Fee (fallback for cross-chain fees) ============

export interface LiFiBridgeFee {
  bridgeName: string;
  totalFeeUsd: number; // all bridge/protocol fees in USD
  gasUsd: number; // gas cost in USD
  toAmount: string; // amount received
  executionDuration: number; // seconds
}

export async function getLiFiBridgeFee(
  fromChainId: string,
  toChainId: string,
  fromTokenAddress: string,
  toTokenAddress: string,
  amount: string,
): Promise<LiFiBridgeFee | null> {
  try {
    const params = new URLSearchParams({
      fromChain: fromChainId,
      toChain: toChainId,
      fromToken: fromTokenAddress,
      toToken: toTokenAddress,
      fromAmount: amount,
      fromAddress: "0x0000000000000000000000000000000000000001",
    });
    const url = `https://li.quest/v1/quote?${params.toString()}`;
    const res = await axios.get(url, { timeout: 15000 });

    if (res.data?.estimate) {
      const est = res.data.estimate;
      let totalFeeUsd = 0;
      for (const fee of est.feeCosts || []) {
        totalFeeUsd += parseFloat(fee.amountUSD || "0");
      }
      let gasUsd = 0;
      for (const gas of est.gasCosts || []) {
        gasUsd += parseFloat(gas.amountUSD || "0");
      }
      return {
        bridgeName: est.tool || res.data.tool || "unknown",
        totalFeeUsd,
        gasUsd,
        toAmount: est.toAmount || "0",
        executionDuration: est.executionDuration || 0,
      };
    }
    return null;
  } catch (e: any) {
    const msg = e.response?.data?.message || e.message;
    console.error(`    [lifi err] ${fromChainId}->${toChainId}: ${msg}`);
    return null;
  }
}

// ============ Gas Price (v6) ============

export async function getGasPrice(chainIndex: string): Promise<number> {
  try {
    const params = new URLSearchParams({ chainIndex });
    const path = `/api/v6/dex/pre-transaction/gas-price`;
    const qs = "?" + params.toString();
    const headers = web3Headers("GET", path, qs);

    const res = await axios.get(`${WEB3_BASE_URL}${path}${qs}`, { headers });
    if (res.data.code === "0" && res.data.data?.[0]) {
      const d = res.data.data[0];
      // Prefer EIP-1559 maxFeePerGas, fallback to normal gasPrice
      if (d.eip1559?.maxFeePerGas) return parseFloat(d.eip1559.maxFeePerGas);
      if (d.normal?.gasPrice) return parseFloat(d.normal.gasPrice);
      if (typeof d.normal === "string") return parseFloat(d.normal);
      return parseFloat(d.gasPrice || "0");
    }
    return 0;
  } catch (e: any) {
    console.error(`    [gas-price err] chain=${chainIndex} ${e.message}`);
    return 0;
  }
}

// ============ K-line Candles (v6) ============

export interface CandleData {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}

export async function getCandles(
  chainIndex: string,
  tokenAddress: string,
  bar: string = "1H",
  limit: number = 100,
): Promise<CandleData[]> {
  try {
    const params = new URLSearchParams({
      chainIndex,
      tokenContractAddress: tokenAddress,
      bar,
      limit: String(Math.min(limit, 299)),
    });
    const path = `/api/v6/dex/market/candles`;
    const qs = "?" + params.toString();
    const headers = web3Headers("GET", path, qs);

    const res = await axios.get(`${WEB3_BASE_URL}${path}${qs}`, { headers });
    if (res.data.code === "0" && res.data.data) {
      return res.data.data.map((c: any) => {
        // Handle both array and object response formats
        if (Array.isArray(c)) {
          return {
            ts: Number(c[0]),
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            vol: Number(c[5] || 0),
          };
        }
        return {
          ts: Number(c.ts),
          open: Number(c.o || c.open),
          high: Number(c.h || c.high),
          low: Number(c.l || c.low),
          close: Number(c.c || c.close),
          vol: Number(c.vol || c.volume || 0),
        };
      });
    }
    return [];
  } catch {
    return [];
  }
}

// ============ CEX (v5) ============

export interface Ticker {
  instId: string;
  last: string;
  bidPx: string;
  askPx: string;
}

export async function getCexTickers(): Promise<Map<string, Ticker>> {
  const map = new Map<string, Ticker>();
  try {
    // Public endpoint, no auth needed
    const res = await axios.get(
      `${CEX_BASE_URL}/api/v5/market/tickers?instType=SPOT`,
    );
    if (res.data.code === "0") {
      for (const t of res.data.data) {
        map.set(t.instId, {
          instId: t.instId,
          last: t.last,
          bidPx: t.bidPx,
          askPx: t.askPx,
        });
      }
    }
  } catch (e: any) {
    console.error(`  CEX tickers failed: ${e.message}`);
  }
  return map;
}

export interface CurrencyStatus {
  ccy: string;
  chain: string;
  canDep: boolean;
  canWd: boolean;
  minFee: string;
  maxFee: string;
}

export async function getCurrencies(): Promise<CurrencyStatus[]> {
  try {
    const path = "/api/v5/asset/currencies";
    const headers = cexHeaders("GET", path);
    const res = await axios.get(`${CEX_BASE_URL}${path}`, { headers });

    if (res.data.code === "0") {
      return res.data.data.map((c: any) => ({
        ccy: c.ccy,
        chain: c.chain,
        canDep: c.canDep,
        canWd: c.canWd,
        minFee: c.minFee,
        maxFee: c.maxFee,
      }));
    }
  } catch (e: any) {
    console.error(`  Currencies failed: ${e.message}`);
  }
  return [];
}
