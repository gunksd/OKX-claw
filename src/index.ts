import "dotenv/config";
import { TOKENS } from "./config.js";
import { getCexTickers, getCurrencies, getGasPrice } from "./api.js";
import {
  scanDexPrices,
  findCrossChainArbs,
  findDexCexArbs,
  validateOpp,
  type ArbOpportunity,
  type DexPrice,
} from "./scanner.js";

const SEP = "=".repeat(100);
const LINE = "-".repeat(100);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n${SEP}`);
  console.log("  OKX-Claw Arbitrage Scanner");
  console.log(`  ${new Date().toISOString()}`);
  console.log(SEP);

  // Filter out tokens with no chain config
  const tokens = TOKENS.filter((t) => Object.keys(t.chains).length > 0);
  console.log(`\nTargets: ${tokens.map((t) => t.symbol).join(", ")}\n`);

  // 1. CEX data
  console.log("[1/4] Fetching CEX prices & deposit/withdraw status...");
  const [tickers, currencies] = await Promise.all([
    getCexTickers(),
    getCurrencies(),
  ]);
  console.log(
    `  Tickers: ${tickers.size} pairs, Currencies: ${currencies.length} entries`,
  );

  for (const t of tokens) {
    const tk = tickers.get(t.cexInstId);
    if (tk) console.log(`  ${t.cexInstId}: $${tk.last}`);
  }

  // 2. Gas prices
  console.log("\n[2/5] Fetching gas prices...");
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

  // 3. DEX prices
  console.log("\n[3/5] Scanning DEX prices across chains...");
  const allOpps: ArbOpportunity[] = [];
  const allDexPrices: Map<string, DexPrice[]> = new Map();

  for (const token of tokens) {
    const chainCount = Object.keys(token.chains).length;
    process.stdout.write(`  ${token.symbol} (${chainCount} chains): `);

    const prices = await scanDexPrices(token);
    if (prices.length === 0) {
      console.log("no prices");
      continue;
    }

    allDexPrices.set(token.symbol, prices);

    const priceStr = prices
      .map((p) => `${p.chainName}=$${p.price.toFixed(4)}`)
      .join(", ");
    console.log(priceStr);

    const crossChain = findCrossChainArbs(token, prices);
    const dexCex = findDexCexArbs(token, prices, tickers, currencies);
    allOpps.push(...crossChain, ...dexCex);
    await sleep(1100); // respect global rate limit between tokens
  }

  if (allOpps.length === 0) {
    console.log("\n[Result] No opportunities above threshold.\n");
    return;
  }

  // 4. Validate
  console.log(`\n[4/5] Validating ${allOpps.length} opportunities...`);
  for (const opp of allOpps) {
    const token = tokens.find((t) => t.symbol === opp.token)!;
    const prices = allDexPrices.get(opp.token) || [];
    await validateOpp(opp, token, prices, currencies, tickers, gasPrices);
    const icon = opp.validated ? "V" : "X";
    console.log(
      `  [${icon}] ${opp.token} ${opp.type}: ${opp.buyAt} -> ${opp.sellAt} | ${opp.spreadPct.toFixed(3)}% | ${opp.detail}`,
    );
  }

  // 5. Results
  console.log(`\n[5/5] Results\n${SEP}`);

  const passed = allOpps.filter((o) => o.validated);
  const blocked = allOpps.filter(
    (o) => !o.validated && o.detail.includes("BLOCKED"),
  );
  const failed = allOpps.filter(
    (o) => !o.validated && !o.detail.includes("BLOCKED"),
  );

  if (passed.length > 0) {
    console.log("\n  VALIDATED OPPORTUNITIES");
    console.log(`  ${LINE}`);
    printTable(passed);
  }

  if (blocked.length > 0) {
    console.log("\n  BLOCKED (deposit/withdraw suspended)");
    console.log(`  ${LINE}`);
    printTable(blocked);
  }

  if (failed.length > 0) {
    console.log("\n  FAILED VALIDATION");
    console.log(`  ${LINE}`);
    printTable(failed);
  }

  console.log(
    `\n  Summary: ${passed.length} valid | ${blocked.length} blocked | ${failed.length} failed`,
  );
  console.log(SEP + "\n");
}

function printTable(opps: ArbOpportunity[]) {
  console.log(
    "  " +
      [
        "Token".padEnd(6),
        "Type".padEnd(16),
        "Buy".padEnd(22),
        "Sell".padEnd(22),
        "Spread".padEnd(9),
        "Net%".padEnd(8),
        "Net$".padEnd(8),
        "Gas$".padEnd(8),
        "Slip$".padEnd(8),
        "D/W".padEnd(5),
        "Detail",
      ].join(" | "),
  );

  for (const o of opps) {
    const dw = o.dwUnknown
      ? "?/?"
      : `${o.canDeposit ? "Y" : "N"}/${o.canWithdraw ? "Y" : "N"}`;
    console.log(
      "  " +
        [
          o.token.padEnd(6),
          o.type.padEnd(16),
          `${o.buyAt} $${o.buyPrice.toFixed(2)}`.padEnd(22),
          `${o.sellAt} $${o.sellPrice.toFixed(2)}`.padEnd(22),
          `${o.spreadPct.toFixed(3)}%`.padEnd(9),
          `${o.netProfitPct.toFixed(2)}%`.padEnd(8),
          `$${o.netProfitUsd.toFixed(2)}`.padEnd(8),
          `$${o.gasCostUsd.toFixed(2)}`.padEnd(8),
          `$${o.slippageCostUsd.toFixed(2)}`.padEnd(8),
          dw.padEnd(5),
          o.detail.substring(0, 60),
        ].join(" | "),
    );
  }
}

main().catch(console.error);
