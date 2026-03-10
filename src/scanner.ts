import {
  getDexQuote,
  getSwapTx,
  simulate,
  getCrossChainQuote,
  getLiFiBridgeFee,
  type QuoteResult,
  type Ticker,
  type CurrencyStatus,
} from "./api.js";
import {
  CHAINS,
  USDC,
  WNATIVE,
  ARB_THRESHOLD_PCT,
  MIN_NET_PROFIT_PCT,
  TRADE_SIZE_USD,
  CEX_CHAIN_MAP,
  CHAIN_NATIVE,
  estimateBridgeCostUsd,
  type TokenConfig,
  type CrossChainPath,
} from "./config.js";

// ============ Types ============

export interface DexPrice {
  chainIndex: string;
  chainName: string;
  price: number; // USD unit price
  priceImpactPct: number;
  tradeFeeUsd: number; // network fee in USD (from OKX tradeFee field, fallback)
  estimateGasFee: string; // gas units from quote (gasLimit)
  quote: QuoteResult;
}

export interface ArbOpportunity {
  type: "cross-chain" | "dex-cex" | "cross-chain-path";
  token: string;
  buyAt: string;
  buyPrice: number;
  sellAt: string;
  sellPrice: number;
  spreadPct: number;
  canDeposit: boolean;
  canWithdraw: boolean;
  dwUnknown: boolean;
  validated: boolean;
  detail: string;
  // Net profit fields (filled after validation)
  netProfitUsd: number; // profit after gas + slippage + bridge per $TRADE_SIZE traded
  netProfitPct: number; // net profit as % of trade size (must exceed MIN_NET_PROFIT_PCT)
  gasCostUsd: number;
  slippageCostUsd: number;
  bridgeFeeUsd: number;
}

// ============ Scan DEX prices (rate-limited) ============

const DELAY_MS = 1500; // OKX rate limit buffer — 1.5s between requests
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function scanDexPrices(token: TokenConfig): Promise<DexPrice[]> {
  const entries = Object.entries(token.chains).filter(([ci]) => USDC[ci]);
  const prices: DexPrice[] = [];

  for (const [chainIndex, info] of entries) {
    const quote = await getDexQuote(
      chainIndex,
      info.address,
      USDC[chainIndex],
      info.scanAmount,
    );
    if (quote?.toTokenAmount && quote?.fromTokenAmount) {
      // Calculate effective price from ACTUAL swap amounts, not oracle price
      const fromDec =
        parseInt(quote.fromToken?.decimal || "0") || info.decimals;
      const toDec = parseInt(quote.toToken?.decimal || "0") || 6; // USDC default
      const fromAmt = Number(quote.fromTokenAmount) / Math.pow(10, fromDec);
      const toAmt = Number(quote.toTokenAmount) / Math.pow(10, toDec);
      const effectivePrice = fromAmt > 0 ? toAmt / fromAmt : 0;

      if (effectivePrice > 0) {
        const chain = CHAINS.find((c) => c.chainIndex === chainIndex);
        const oraclePrice = parseFloat(quote.fromToken?.tokenUnitPrice || "0");
        console.log(
          `    [price] ${token.symbol}@${chain?.name || chainIndex}: effective=$${effectivePrice.toFixed(6)} oracle=$${oraclePrice.toFixed(6)} (from=${fromAmt.toFixed(6)} to=${toAmt.toFixed(6)} USDC)`,
        );
        prices.push({
          chainIndex,
          chainName: chain?.name || chainIndex,
          price: effectivePrice,
          priceImpactPct: parseFloat(quote.priceImpactPercent || "0"),
          tradeFeeUsd: parseFloat(quote.tradeFee || "0"),
          estimateGasFee: quote.estimateGasFee || "0",
          quote,
        });
      }
    }
    await sleep(DELAY_MS);
  }

  return prices;
}

// ============ Find cross-chain arbs ============

export function findCrossChainArbs(
  token: TokenConfig,
  prices: DexPrice[],
): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];
  for (let i = 0; i < prices.length; i++) {
    for (let j = i + 1; j < prices.length; j++) {
      const a = prices[i],
        b = prices[j];
      if (a.price <= 0 || b.price <= 0) continue;
      const spread = ((b.price - a.price) / a.price) * 100;
      if (Math.abs(spread) < ARB_THRESHOLD_PCT) continue;

      const [buy, sell] = spread > 0 ? [a, b] : [b, a];
      opps.push({
        type: "cross-chain",
        token: token.symbol,
        buyAt: buy.chainName,
        buyPrice: buy.price,
        sellAt: sell.chainName,
        sellPrice: sell.price,
        spreadPct: Math.abs(spread),
        canDeposit: true,
        canWithdraw: true,
        dwUnknown: false,
        validated: false,
        detail: "pending",
        netProfitUsd: 0,
        netProfitPct: 0,
        gasCostUsd: 0,
        slippageCostUsd: 0,
        bridgeFeeUsd: 0,
      });
    }
  }
  return opps.sort((a, b) => b.spreadPct - a.spreadPct);
}

// ============ Find DEX-CEX arbs ============

export function findDexCexArbs(
  token: TokenConfig,
  dexPrices: DexPrice[],
  tickers: Map<string, Ticker>,
  currencies: CurrencyStatus[],
): ArbOpportunity[] {
  const opps: ArbOpportunity[] = [];
  const ticker = tickers.get(token.cexInstId);
  if (!ticker) return opps;

  const cexPrice = parseFloat(ticker.last);
  if (cexPrice <= 0) return opps;

  // Build deposit/withdraw status map: chainIndex -> { canDep, canWd }
  const dwStatus = buildDepositWithdrawMap(token.symbol, currencies);

  for (const dex of dexPrices) {
    const spread = ((dex.price - cexPrice) / cexPrice) * 100;
    if (Math.abs(spread) < ARB_THRESHOLD_PCT) continue;

    const status = dwStatus.get(dex.chainIndex);
    // If no currency data available, mark as unknown (true) so it still gets validated
    const canDep = status?.canDep ?? true;
    const canWd = status?.canWd ?? true;
    const dwUnknown = !status;

    const dexLabel = `DEX(${dex.chainName})`;
    const [buyAt, buyPrice, sellAt, sellPrice] =
      spread > 0
        ? ["CEX", cexPrice, dexLabel, dex.price]
        : [dexLabel, dex.price, "CEX", cexPrice];

    opps.push({
      type: "dex-cex",
      token: token.symbol,
      buyAt,
      buyPrice,
      sellAt,
      sellPrice,
      spreadPct: Math.abs(spread),
      canDeposit: canDep,
      canWithdraw: canWd,
      dwUnknown,
      validated: false,
      detail:
        !canDep || !canWd
          ? "BLOCKED: deposit/withdraw suspended"
          : dwUnknown
            ? "pending (D/W status unknown, verify manually)"
            : "pending",
      netProfitUsd: 0,
      netProfitPct: 0,
      gasCostUsd: 0,
      slippageCostUsd: 0,
      bridgeFeeUsd: 0,
    });
  }
  return opps.sort((a, b) => b.spreadPct - a.spreadPct);
}

// ============ Validate with larger quote + simulate ============

export async function validateOpp(
  opp: ArbOpportunity,
  token: TokenConfig,
  dexPrices: DexPrice[],
  currencies: CurrencyStatus[],
  tickers: Map<string, Ticker>,
  gasPrices: Map<string, number>, // chainIndex -> gasPrice in wei
): Promise<ArbOpportunity> {
  // Skip if deposit/withdraw blocked
  if (opp.type === "dex-cex" && (!opp.canDeposit || !opp.canWithdraw)) {
    opp.detail = "SKIP: deposit or withdraw suspended on CEX";
    return opp;
  }

  // ---- Resolve DEX chains for both sides ----
  let dexBuyChainIdx: string | null = null;
  let dexSellChainIdx: string | null = null;

  if (opp.type === "dex-cex") {
    if (opp.buyAt === "CEX") {
      dexSellChainIdx = resolveChainIndex(opp.sellAt);
    } else {
      dexBuyChainIdx = resolveChainIndex(opp.buyAt);
    }
  } else {
    // Cross-chain: both sides are DEX
    dexBuyChainIdx = resolveChainIndex(opp.buyAt);
    dexSellChainIdx = resolveChainIndex(opp.sellAt);
  }

  const primaryDexChain = dexBuyChainIdx || dexSellChainIdx;
  if (
    !primaryDexChain ||
    !token.chains[primaryDexChain] ||
    !USDC[primaryDexChain]
  ) {
    opp.detail = "SKIP: cannot resolve chain for validation";
    return opp;
  }

  // ---- Re-quote BUY side at 5x (if DEX) ----
  let actualBuyPrice = opp.buyPrice;
  let buyImpact = 0;
  let buyQuote: QuoteResult | null = null;
  let buyChainIndex = primaryDexChain;

  if (dexBuyChainIdx && token.chains[dexBuyChainIdx] && USDC[dexBuyChainIdx]) {
    const info = token.chains[dexBuyChainIdx];
    const largeAmount = (BigInt(info.scanAmount) * 5n).toString();
    await sleep(DELAY_MS);
    const quote = await getDexQuote(
      dexBuyChainIdx,
      info.address,
      USDC[dexBuyChainIdx],
      largeAmount,
    );
    if (!quote?.toTokenAmount || !quote?.fromTokenAmount) {
      opp.detail = "FAIL: buy-side 5x quote failed";
      return opp;
    }
    const fromDec = parseInt(quote.fromToken?.decimal || "0") || info.decimals;
    const toDec = parseInt(quote.toToken?.decimal || "0") || 6;
    const fromAmt = Number(quote.fromTokenAmount) / Math.pow(10, fromDec);
    const toAmt = Number(quote.toTokenAmount) / Math.pow(10, toDec);
    actualBuyPrice = fromAmt > 0 ? toAmt / fromAmt : 0;
    buyImpact = Math.abs(parseFloat(quote.priceImpactPercent || "0"));
    buyQuote = quote;
    buyChainIndex = dexBuyChainIdx;

    if (actualBuyPrice <= 0) {
      opp.detail = "FAIL: invalid buy-side effective price";
      return opp;
    }
    console.log(
      `    [validate] ${opp.token} buy@${opp.buyAt}: $${actualBuyPrice.toFixed(6)} (5x, impact=${buyImpact.toFixed(2)}%)`,
    );
  }

  // ---- Re-quote SELL side at 5x (if DEX) ----
  let actualSellPrice = opp.sellPrice;
  let sellImpact = 0;
  let sellQuote: QuoteResult | null = null;

  if (
    dexSellChainIdx &&
    token.chains[dexSellChainIdx] &&
    USDC[dexSellChainIdx]
  ) {
    const info = token.chains[dexSellChainIdx];
    const largeAmount = (BigInt(info.scanAmount) * 5n).toString();
    await sleep(DELAY_MS);
    const quote = await getDexQuote(
      dexSellChainIdx,
      info.address,
      USDC[dexSellChainIdx],
      largeAmount,
    );
    if (quote?.toTokenAmount && quote?.fromTokenAmount) {
      const fromDec =
        parseInt(quote.fromToken?.decimal || "0") || info.decimals;
      const toDec = parseInt(quote.toToken?.decimal || "0") || 6;
      const fromAmt = Number(quote.fromTokenAmount) / Math.pow(10, fromDec);
      const toAmt = Number(quote.toTokenAmount) / Math.pow(10, toDec);
      const effSellPrice = fromAmt > 0 ? toAmt / fromAmt : 0;
      if (effSellPrice > 0) {
        actualSellPrice = effSellPrice;
        sellImpact = Math.abs(parseFloat(quote.priceImpactPercent || "0"));
        sellQuote = quote;
      }
    }
    console.log(
      `    [validate] ${opp.token} sell@${opp.sellAt}: $${actualSellPrice.toFixed(6)} (5x, impact=${sellImpact.toFixed(2)}%)`,
    );
  }

  // ---- Check price impact ----
  const maxImpact = Math.max(buyImpact, sellImpact);
  if (maxImpact > 5) {
    opp.detail = `FAIL: price impact too high (buy=${buyImpact.toFixed(2)}%, sell=${sellImpact.toFixed(2)}%)`;
    return opp;
  }

  // ---- Calculate validated spread from BOTH sides ----
  const realSpread =
    ((actualSellPrice - actualBuyPrice) / actualBuyPrice) * 100;
  if (realSpread < ARB_THRESHOLD_PCT) {
    opp.detail = `FAIL: validated spread ${realSpread.toFixed(3)}% (buy=$${actualBuyPrice.toFixed(4)} sell=$${actualSellPrice.toFixed(4)})`;
    return opp;
  }

  // ---- Calculate net profit per $TRADE_SIZE_USD ----
  const grossProfitUsd = (TRADE_SIZE_USD * realSpread) / 100;

  // Gas cost — use whichever side has a validation quote
  const primaryQuote = buyQuote || sellQuote;
  const native = CHAIN_NATIVE[buyChainIndex];
  const nativeTicker = tickers.get(native?.cexPair || "");
  const nativePrice = nativeTicker ? parseFloat(nativeTicker.last) : 0;

  let buyGasUsd = 0;
  if (primaryQuote) {
    const gasFeeRaw = parseFloat(primaryQuote.estimateGasFee || "0");
    const gp = gasPrices.get(buyChainIndex) || 0;
    if (gasFeeRaw > 0 && nativePrice > 0) {
      let gasNative: number;
      if (gasFeeRaw < 1e9) {
        gasNative = gp > 0 ? (gasFeeRaw * gp) / 1e18 : 0;
      } else {
        gasNative = gasFeeRaw / 1e18;
      }
      if (gasNative > 0.5) {
        buyGasUsd = parseFloat(primaryQuote.tradeFee || "0");
      } else {
        buyGasUsd = gasNative * nativePrice;
      }
    }
    if (buyGasUsd <= 0) {
      buyGasUsd = parseFloat(primaryQuote.tradeFee || "0");
    }
  }

  // Sell-side gas for cross-chain arbs
  let sellGasUsd = 0;
  if (opp.type === "cross-chain" && dexSellChainIdx) {
    const sellDex = dexPrices.find((p) => p.chainIndex === dexSellChainIdx);
    if (sellDex) {
      const sellGasFeeRaw = parseFloat(sellDex.estimateGasFee || "0");
      const sellGasPrice = gasPrices.get(dexSellChainIdx) || 0;
      const sellNative = CHAIN_NATIVE[dexSellChainIdx];
      const sellNativeTicker = tickers.get(sellNative?.cexPair || "");
      const sellNativePrice = sellNativeTicker
        ? parseFloat(sellNativeTicker.last)
        : 0;
      if (sellGasFeeRaw > 0 && sellNativePrice > 0) {
        let sellGasNative: number;
        if (sellGasFeeRaw < 1e9) {
          sellGasNative =
            sellGasPrice > 0 ? (sellGasFeeRaw * sellGasPrice) / 1e18 : 0;
        } else {
          sellGasNative = sellGasFeeRaw / 1e18;
        }
        if (sellGasNative > 0.5) {
          sellGasUsd = sellDex.tradeFeeUsd;
        } else {
          sellGasUsd = sellGasNative * sellNativePrice;
        }
      } else {
        sellGasUsd = sellDex.tradeFeeUsd;
      }
    }
  }

  const totalGasUsd = buyGasUsd + sellGasUsd;

  // Slippage: effective prices already include price impact at 5x volume,
  // so no separate slippage cost (avoids double-counting)
  const slippageCostUsd = 0;

  // Bridge / transfer fee
  let bridgeFeeUsd = 0;
  let bridgeSource = "";
  if (opp.type === "cross-chain" && dexBuyChainIdx && dexSellChainIdx) {
    const buyInfo = token.chains[dexBuyChainIdx];
    const wallet =
      process.env.EVM_WALLET_ADDRESS ||
      "0x0000000000000000000000000000000000000001";
    await sleep(DELAY_MS);
    const ccQuote = await getCrossChainQuote(
      dexBuyChainIdx,
      dexSellChainIdx,
      buyInfo.address,
      token.chains[dexSellChainIdx]?.address || buyInfo.address,
      buyInfo.scanAmount,
      wallet,
    );
    if (ccQuote) {
      const rawCcFee = parseFloat(ccQuote.crossChainFee || "0");
      const feeTokenAddr = (
        ccQuote.crossChainFeeTokenAddress || ""
      ).toLowerCase();
      const isNativeAddr =
        feeTokenAddr === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const wethAddrs = Object.values(WNATIVE).map((a) => a.toLowerCase());
      const isWeth = wethAddrs.includes(feeTokenAddr);

      let ccFeeUsd: number;
      if (isNativeAddr || isWeth) {
        const srcNative = CHAIN_NATIVE[dexBuyChainIdx];
        const srcNativeTicker = tickers.get(srcNative?.cexPair || "");
        const srcNativePrice = srcNativeTicker
          ? parseFloat(srcNativeTicker.last)
          : 0;
        ccFeeUsd = rawCcFee * srcNativePrice;
      } else {
        ccFeeUsd = rawCcFee;
      }

      const nativeFeeRaw = parseFloat(ccQuote.otherNativeFee || "0");
      let nativeFeeUsd = 0;
      if (nativeFeeRaw > 0) {
        const srcNative = CHAIN_NATIVE[dexBuyChainIdx];
        const srcNativeTicker = tickers.get(srcNative?.cexPair || "");
        const srcNativePrice = srcNativeTicker
          ? parseFloat(srcNativeTicker.last)
          : 0;
        nativeFeeUsd = nativeFeeRaw * srcNativePrice;
      }

      bridgeFeeUsd = ccFeeUsd + nativeFeeUsd;
      bridgeSource = `bridge=${ccQuote.bridgeName}, ccFee=$${ccFeeUsd.toFixed(2)}, nativeFee=$${nativeFeeUsd.toFixed(2)}`;
      console.log(
        `    [bridge] ${opp.token} ${dexBuyChainIdx}->${dexSellChainIdx}: ${bridgeSource}`,
      );
    } else {
      await sleep(DELAY_MS);
      const lifi = await getLiFiBridgeFee(
        dexBuyChainIdx,
        dexSellChainIdx,
        buyInfo.address,
        token.chains[dexSellChainIdx]?.address || buyInfo.address,
        buyInfo.scanAmount,
      );
      if (lifi) {
        bridgeFeeUsd = lifi.totalFeeUsd + lifi.gasUsd;
        bridgeSource = `lifi(${lifi.bridgeName}), fee=$${lifi.totalFeeUsd.toFixed(2)}, gas=$${lifi.gasUsd.toFixed(4)}`;
        console.log(
          `    [bridge] ${opp.token} ${dexBuyChainIdx}->${dexSellChainIdx}: ${bridgeSource}`,
        );
      } else {
        bridgeFeeUsd = estimateBridgeCostUsd(dexBuyChainIdx, dexSellChainIdx);
        bridgeSource = "fallback-estimate";
        console.log(
          `    [bridge] ${opp.token} ${dexBuyChainIdx}->${dexSellChainIdx}: all APIs failed, fallback=$${bridgeFeeUsd}`,
        );
      }
    }
  } else if (opp.type === "dex-cex" && opp.buyAt === "CEX") {
    const dexChainIndex = resolveChainIndex(opp.sellAt);
    if (dexChainIndex) {
      const realFee = lookupWithdrawalFeeUsd(
        token.symbol,
        dexChainIndex,
        currencies,
        opp.buyPrice,
      );
      if (realFee >= 0) {
        bridgeFeeUsd = realFee;
        bridgeSource = "cex-withdrawal";
      }
    }
  }

  const netProfitUsd =
    grossProfitUsd - totalGasUsd - slippageCostUsd - bridgeFeeUsd;
  const netProfitPct = (netProfitUsd / TRADE_SIZE_USD) * 100;

  opp.gasCostUsd = totalGasUsd;
  opp.slippageCostUsd = slippageCostUsd;
  opp.bridgeFeeUsd = bridgeFeeUsd;
  opp.netProfitUsd = netProfitUsd;
  opp.netProfitPct = netProfitPct;

  if (netProfitPct < MIN_NET_PROFIT_PCT) {
    opp.detail = `FAIL: net ${netProfitPct.toFixed(2)}% < ${MIN_NET_PROFIT_PCT}% ($${netProfitUsd.toFixed(2)}/$${TRADE_SIZE_USD}, gas=$${totalGasUsd.toFixed(2)}, bridge=$${bridgeFeeUsd.toFixed(2)}, buy=$${actualBuyPrice.toFixed(4)}, sell=$${actualSellPrice.toFixed(4)})`;
    return opp;
  }

  // Try simulate if wallet configured
  let simNote = "";
  const wallet = process.env.EVM_WALLET_ADDRESS;
  if (wallet && dexBuyChainIdx && token.chains[dexBuyChainIdx]) {
    const simInfo = token.chains[dexBuyChainIdx];
    const simAmount = (BigInt(simInfo.scanAmount) * 5n).toString();
    const swapData = await getSwapTx(
      dexBuyChainIdx,
      simInfo.address,
      USDC[dexBuyChainIdx],
      simAmount,
      wallet,
    );
    if (swapData?.tx) {
      const sim = await simulate(
        swapData.tx.from,
        swapData.tx.to,
        swapData.tx.data,
        dexBuyChainIdx,
        swapData.tx.value || "0",
      );
      if (sim) {
        simNote = sim.success ? `, sim OK` : `, sim FAIL: ${sim.failReason}`;
        if (!sim.success) {
          opp.detail = `FAIL: simulation reverted - ${sim.failReason}`;
          return opp;
        }
      }
    }
  }

  opp.validated = true;
  opp.buyPrice = actualBuyPrice;
  opp.sellPrice = actualSellPrice;
  opp.spreadPct = realSpread;
  opp.detail = `PASS: net ${netProfitPct.toFixed(2)}% ($${netProfitUsd.toFixed(2)}/$${TRADE_SIZE_USD}, gas=$${totalGasUsd.toFixed(2)}, bridge=$${bridgeFeeUsd.toFixed(2)}, spread=${realSpread.toFixed(3)}%, buy=$${actualBuyPrice.toFixed(4)}, sell=$${actualSellPrice.toFixed(4)})${simNote}`;
  return opp;
}

// ============ Helpers ============

/**
 * Look up real CEX withdrawal fee for a token on a specific chain.
 * Returns fee in USD, or -1 if no data found (caller should use fallback).
 */
function lookupWithdrawalFeeUsd(
  symbol: string,
  chainIndex: string,
  currencies: CurrencyStatus[],
  tokenPriceUsd: number,
): number {
  for (const cur of currencies) {
    if (cur.ccy.toUpperCase() !== symbol.toUpperCase()) continue;
    const dashIdx = cur.chain.indexOf("-");
    if (dashIdx < 0) continue;
    const network = cur.chain.substring(dashIdx + 1);
    const ci = CEX_CHAIN_MAP[network];
    if (ci === chainIndex) {
      // minFee is in token units (e.g. "0.001" ETH), convert to USD
      return parseFloat(cur.minFee) * tokenPriceUsd;
    }
  }
  return -1; // not found
}

function buildDepositWithdrawMap(
  symbol: string,
  currencies: CurrencyStatus[],
): Map<string, { canDep: boolean; canWd: boolean }> {
  const map = new Map<string, { canDep: boolean; canWd: boolean }>();
  for (const c of currencies) {
    if (c.ccy.toUpperCase() !== symbol.toUpperCase()) continue;
    // c.chain format: "ETH-ERC20", "USDT-Arbitrum One", etc.
    const dashIdx = c.chain.indexOf("-");
    if (dashIdx < 0) continue;
    const network = c.chain.substring(dashIdx + 1);
    const chainIndex = CEX_CHAIN_MAP[network];
    if (chainIndex) {
      map.set(chainIndex, { canDep: c.canDep, canWd: c.canWd });
    }
  }
  return map;
}

function resolveChainIndex(label: string): string | null {
  // Handle "DEX(Ethereum)" format
  const m = label.match(/DEX\((\w+)\)/);
  const name = m ? m[1] : label;
  if (name === "CEX") return null;
  const chain = CHAINS.find((c) => c.name.toLowerCase() === name.toLowerCase());
  return chain?.chainIndex ?? null;
}

// ============ Cross-chain path evaluation (triangle arb) ============

export async function evaluateCrossChainPath(
  path: CrossChainPath,
  tickers: Map<string, Ticker>,
): Promise<ArbOpportunity | null> {
  const fromChainName =
    CHAINS.find((c) => c.chainIndex === path.fromChainIndex)?.name ||
    path.fromChainIndex;
  const toChainName =
    CHAINS.find((c) => c.chainIndex === path.toChainIndex)?.name ||
    path.toChainIndex;

  // Step 1: Get cross-chain swap quote via LI.FI
  //   fromToken(chainA) → toToken(chainB)
  await sleep(DELAY_MS);
  const lifi = await getLiFiBridgeFee(
    path.fromChainIndex,
    path.toChainIndex,
    path.fromTokenAddress,
    path.toTokenAddress,
    path.amount,
  );

  if (!lifi || lifi.toAmount === "0") {
    console.log(`    [path] ${path.label}: LI.FI quote failed`);
    return null;
  }

  const bridgeFeeUsd = lifi.totalFeeUsd + lifi.gasUsd;
  const receivedAmount = lifi.toAmount; // amount of toToken received on dest chain

  // Step 2: Sell received toToken for sellToken (usually USDC) on dest chain via DEX
  await sleep(DELAY_MS);
  const sellQuote = await getDexQuote(
    path.toChainIndex,
    path.toTokenAddress,
    path.sellTokenAddress,
    receivedAmount,
  );

  if (!sellQuote) {
    console.log(`    [path] ${path.label}: DEX sell quote failed`);
    return null;
  }

  // Calculate input and output in USD
  // Input: fromToken amount → convert to USD
  // If fromToken is a stablecoin (USDC/USDT), amount / 10^decimals ≈ USD
  const inputAmount =
    Number(BigInt(path.amount)) / Math.pow(10, path.fromTokenDecimals);
  const isFromStable = isStablecoin(path.fromTokenSymbol);
  let inputUsd: number;
  if (isFromStable) {
    inputUsd = inputAmount;
  } else {
    // Use fromToken DEX price if available
    const fromTokenPrice = parseFloat(
      sellQuote.fromToken?.tokenUnitPrice || "0",
    );
    inputUsd = fromTokenPrice > 0 ? inputAmount * fromTokenPrice : 0;
  }
  if (inputUsd <= 0) {
    console.log(`    [path] ${path.label}: cannot determine input USD value`);
    return null;
  }

  // Output: sellToken amount → convert to USD
  const outputAmount =
    Number(BigInt(sellQuote.toTokenAmount)) /
    Math.pow(10, path.sellTokenDecimals);
  const isToStable = isStablecoin(path.sellTokenSymbol);
  let outputUsd: number;
  if (isToStable) {
    outputUsd = outputAmount;
  } else {
    const sellTokenPrice = parseFloat(sellQuote.toToken?.tokenUnitPrice || "0");
    outputUsd = sellTokenPrice > 0 ? outputAmount * sellTokenPrice : 0;
  }

  if (outputUsd <= 0) {
    console.log(`    [path] ${path.label}: cannot determine output USD value`);
    return null;
  }

  // Step 3: Calculate profit
  const grossProfitUsd = outputUsd - inputUsd;
  const grossProfitPct = (grossProfitUsd / inputUsd) * 100;

  // Sell-side gas cost
  let sellGasUsd = parseFloat(sellQuote.tradeFee || "0");
  const sellGasFeeRaw = parseFloat(sellQuote.estimateGasFee || "0");
  const native = CHAIN_NATIVE[path.toChainIndex];
  const nativeTicker = tickers.get(native?.cexPair || "");
  const nativePrice = nativeTicker ? parseFloat(nativeTicker.last) : 0;
  if (sellGasFeeRaw > 0 && nativePrice > 0) {
    const gasNative = sellGasFeeRaw < 1e9 ? 0 : sellGasFeeRaw / 1e18;
    if (gasNative > 0 && gasNative <= 0.5) {
      sellGasUsd = gasNative * nativePrice;
    }
  }

  const slippagePct = parseFloat(sellQuote.priceImpactPercent || "0");
  const slippageCostUsd = (outputUsd * slippagePct) / 100;

  const totalCosts = bridgeFeeUsd + sellGasUsd + slippageCostUsd;
  const netProfitUsd = grossProfitUsd - totalCosts;
  const netProfitPct = (netProfitUsd / inputUsd) * 100;

  const spreadPct = grossProfitPct;

  const opp: ArbOpportunity = {
    type: "cross-chain-path",
    token: `${path.fromTokenSymbol}→${path.toTokenSymbol}`,
    buyAt: `${path.fromTokenSymbol}@${fromChainName}`,
    buyPrice: inputUsd / inputAmount,
    sellAt: `${path.toTokenSymbol}@${toChainName}`,
    sellPrice: outputUsd / outputAmount,
    spreadPct,
    canDeposit: true,
    canWithdraw: true,
    dwUnknown: false,
    validated: false,
    detail: "",
    netProfitUsd,
    netProfitPct,
    gasCostUsd: sellGasUsd,
    slippageCostUsd,
    bridgeFeeUsd,
  };

  if (netProfitPct < MIN_NET_PROFIT_PCT) {
    opp.detail = `FAIL: net ${netProfitPct.toFixed(2)}% < ${MIN_NET_PROFIT_PCT}% (in=$${inputUsd.toFixed(2)}, out=$${outputUsd.toFixed(2)}, bridge=$${bridgeFeeUsd.toFixed(2)}, gas=$${sellGasUsd.toFixed(2)})`;
  } else {
    opp.validated = true;
    opp.detail = `PASS: net ${netProfitPct.toFixed(2)}% ($${netProfitUsd.toFixed(2)}/$${inputUsd.toFixed(0)}, bridge=$${bridgeFeeUsd.toFixed(2)}, gas=$${sellGasUsd.toFixed(2)}, via ${lifi.bridgeName})`;
  }

  console.log(
    `    [path] ${path.label}: ${opp.validated ? "PASS" : "FAIL"} net=${netProfitPct.toFixed(2)}% in=$${inputUsd.toFixed(2)} out=$${outputUsd.toFixed(2)} bridge=$${bridgeFeeUsd.toFixed(2)}`,
  );

  return opp;
}

function isStablecoin(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return s === "USDC" || s === "USDT" || s === "DAI" || s === "BUSD";
}
