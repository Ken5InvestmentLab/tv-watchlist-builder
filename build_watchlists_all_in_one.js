const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const YahooFinance = require("yahoo-finance2").default;

const yf = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  queue: { concurrency: 1 },
});

const JPX_LIST_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html";
const OUTPUT_DIR = "output";
const CACHE_DIR = ".cache";
const LOG_DIR = "logs";

const OUTPUT_BASENAME = "tradingview_tse_price_le_1000";
const PRICE_THRESHOLD = 1000;
const MAX_SYMBOLS_PER_FILE = 1000;
const MAX_WATCHLIST_FILES = 2;
const MAX_TOTAL_SYMBOLS = MAX_SYMBOLS_PER_FILE * MAX_WATCHLIST_FILES;

const INCLUDE_PRIME = true;
const INCLUDE_STANDARD = true;
const INCLUDE_GROWTH = true;
const INCLUDE_FOREIGN_STOCKS = true;

const PREFIX = "TSE";

// 429を踏みにくくするため、個別quoteではなく quoteCombine を少量バーストで使う
const INITIAL_BATCH_SIZE = 50;
const MIN_BATCH_SIZE = 10;
const BASE_SLEEP_MS = 2500;
const RANDOM_SLEEP_MIN_MS = 500;
const RANDOM_SLEEP_MAX_MS = 1800;

const MAX_ERROR_LOGS = 30;
const MAX_429_RETRIES_PER_BATCH = 3;
const RETRY_BASE_WAIT_MS = 20000;

// failure化しきい値
const MIN_SUCCESS_RATE = 0.95;     // 95%未満で失敗
const MAX_ERROR_COUNT = 200;       // 失敗件数が多すぎたら失敗
const MAX_429_COUNT = 100;          // 429が多すぎたら失敗

const MARKET_COL_CANDIDATES = ["市場・商品区分", "市場商品区分", "市場区分"];
const CODE_COL_CANDIDATES = ["コード", "銘柄コード"];
const EXCLUDE_KEYWORDS = ["ETF", "ETN", "REIT", "インフラファンド", "出資証券", "優先出資証券"];

let debugCount = 0;
let errorCount = 0;
let rateLimitCount = 0;

const failureDetails = [];
const runLogs = [];

function log(msg) {
  console.log(msg);
  runLogs.push(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleepWithJitter(baseMs) {
  const jitter = randomInt(RANDOM_SLEEP_MIN_MS, RANDOM_SLEEP_MAX_MS);
  return sleep(baseMs + jitter);
}

function ensureDir(p) {
  fs.mkdirSync(path.resolve(p), { recursive: true });
}

function ensureOutputDir() {
  ensureDir(OUTPUT_DIR);
  ensureDir(CACHE_DIR);
  ensureDir(LOG_DIR);
}

function outPath(fileName) {
  return path.resolve(OUTPUT_DIR, fileName);
}

function cachePath(fileName) {
  return path.resolve(CACHE_DIR, fileName);
}

function logPath(fileName) {
  return path.resolve(LOG_DIR, fileName);
}

function normalizeCode(value) {
  if (value === null || value === undefined) return "";
  let s = String(value).trim();
  if (s.endsWith(".0")) s = s.slice(0, -2);
  return s;
}

function pickColumn(columns, candidates) {
  for (const c of candidates) {
    if (columns.includes(c)) return c;
  }
  throw new Error(`必要な列が見つかりませんでした。候補: ${candidates.join(", ")} / 実際の列: ${columns.join(", ")}`);
}

function isPrimeMarket(marketValue) {
  return marketValue.includes("プライム");
}

function isStandardMarket(marketValue) {
  return marketValue.includes("スタンダード");
}

function isGrowthMarket(marketValue) {
  return marketValue.includes("グロース");
}

function isForeignStock(marketValue) {
  return marketValue.includes("外国株式");
}

function isTargetMarket(marketValue) {
  const prime = INCLUDE_PRIME && isPrimeMarket(marketValue);
  const standard = INCLUDE_STANDARD && isStandardMarket(marketValue);
  const growth = INCLUDE_GROWTH && isGrowthMarket(marketValue);
  return prime || standard || growth;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(file, rows) {
  const header = ["tv_symbol", "yahoo_symbol", "previous_close", "volume"];
  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.tv_symbol),
        csvEscape(row.yahoo_symbol),
        csvEscape(String(row.previous_close)),
        csvEscape(String(row.volume ?? "")),
      ].join(",")
    );
  }

  fs.writeFileSync(outPath(file), "\uFEFF" + lines.join("\n"), "utf8");
}

function writeTxt(file, symbols) {
  fs.writeFileSync(outPath(file), symbols.join(","), "utf8");
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

function buildOutputFileName(index) {
  const seq = String(index + 1).padStart(3, "0");
  return `${OUTPUT_BASENAME}_${seq}.txt`;
}

function tvToYahoo(tvSymbol) {
  const [, code] = tvSymbol.split(":");
  return { tvSymbol, yahooSymbol: `${code}.T` };
}

function getJstDateKey() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function buildRunId() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mi = String(jst.getUTCMinutes()).padStart(2, "0");
  const ss = String(jst.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function clearOldOutputFiles() {
  ensureOutputDir();
  const dir = path.resolve(OUTPUT_DIR);

  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith(OUTPUT_BASENAME) && (file.endsWith(".txt") || file.endsWith(".csv") || file.endsWith(".json"))) {
      fs.unlinkSync(path.join(dir, file));
    }
  }
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function resolveUrl(base, relative) {
  return new URL(relative, base).toString();
}

function findJpxExcelUrl(html) {
  const hrefs = [...html.matchAll(/href="([^"]+\.(?:xls|xlsx))"/gi)].map((m) => m[1]);
  const scored = hrefs
    .map((href) => {
      const s = href.toLowerCase();
      let score = 0;
      if (s.includes("data_j")) score += 100;
      if (s.includes("xls")) score += 10;
      if (s.includes("misc")) score += 5;
      return { href, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) throw new Error("JPXページからExcelリンクを見つけられませんでした。");
  return resolveUrl(JPX_LIST_PAGE, scored[0].href);
}

async function downloadJpxWorkbook() {
  const html = await fetchText(JPX_LIST_PAGE);
  const excelUrl = findJpxExcelUrl(html);
  log(`JPX Excel URL: ${excelUrl}`);
  const fileBuffer = await fetchBuffer(excelUrl);
  return XLSX.read(fileBuffer, { type: "buffer" });
}

function extractTradingViewSymbolsFromWorkbook(workbook) {
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
  if (!rows.length) throw new Error("JPXのExcelにデータがありません。");

  const columns = Object.keys(rows[0]).map((c) => String(c).trim());
  const marketCol = pickColumn(columns, MARKET_COL_CANDIDATES);
  const codeCol = pickColumn(columns, CODE_COL_CANDIDATES);

  const symbols = [];
  const seen = new Set();

  for (const row of rows) {
    const marketValue = String(row[marketCol] ?? "").trim();
    const excluded = EXCLUDE_KEYWORDS.some((k) => marketValue.includes(k));
    if (excluded) continue;

    const targetMarket = isTargetMarket(marketValue);
    const foreignStock = isForeignStock(marketValue);
    if (!targetMarket && !(INCLUDE_FOREIGN_STOCKS && foreignStock)) continue;

    const code = normalizeCode(row[codeCol]);
    if (!code) continue;

    const tvSymbol = `${PREFIX}:${code}`;
    if (seen.has(tvSymbol)) continue;
    seen.add(tvSymbol);
    symbols.push(tvSymbol);
  }

  return symbols;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || "");
  return /Too Many Requests|429|rate limit/i.test(msg);
}

function loadDailyCache() {
  const file = cachePath(`yf_quotes_${getJstDateKey()}.json`);
  if (!fs.existsSync(file)) return { file, data: {} };

  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, data };
  } catch {
    return { file, data: {} };
  }
}

function saveDailyCache(file, data) {
  writeJson(file, data);
}

function extractMetricsFromQuoteResult(result, yahooSymbol) {
  if (!result) {
    return { yahooSymbol, previousClose: null, volume: null };
  }

  if (debugCount < 10) {
    log(
      `DEBUG ${yahooSymbol} regularMarketPreviousClose=${result.regularMarketPreviousClose} previousClose=${result.previousClose} regularMarketVolume=${result.regularMarketVolume} averageDailyVolume10Day=${result.averageDailyVolume10Day} averageDailyVolume3Month=${result.averageDailyVolume3Month}`
    );
    debugCount += 1;
  }

  const previousClose = firstFiniteNumber(
    result.regularMarketPreviousClose,
    result.previousClose
  );

  const volume = firstFiniteNumber(
    result.regularMarketVolume,
    result.averageDailyVolume10Day,
    result.averageDailyVolume3Month
  );

  return { yahooSymbol, previousClose, volume };
}

async function fetchBatchWithQuoteCombine(items) {
  const results = await Promise.all(
    items.map(async (item) => {
      const result = await yf.quoteCombine(item.yahooSymbol);
      const metrics = extractMetricsFromQuoteResult(result, item.yahooSymbol);
      return {
        tv_symbol: item.tvSymbol,
        yahoo_symbol: item.yahooSymbol,
        previous_close: metrics.previousClose,
        volume: metrics.volume,
      };
    })
  );

  return results;
}

async function fetchBatchAdaptive(items, attempt = 1) {
  try {
    return await fetchBatchWithQuoteCombine(items);
  } catch (err) {
    if (!isRateLimitError(err)) throw err;

    rateLimitCount += 1;

    if (attempt <= MAX_429_RETRIES_PER_BATCH) {
      const waitMs = RETRY_BASE_WAIT_MS * attempt + randomInt(2000, 6000);
      log(`[429] batch size=${items.length} attempt=${attempt}/${MAX_429_RETRIES_PER_BATCH} wait=${waitMs}ms`);
      await sleep(waitMs);
      return await fetchBatchAdaptive(items, attempt + 1);
    }

    if (items.length > MIN_BATCH_SIZE) {
      const mid = Math.ceil(items.length / 2);
      const left = items.slice(0, mid);
      const right = items.slice(mid);

      log(`[429] split batch ${items.length} -> ${left.length} + ${right.length}`);

      const leftResults = await fetchBatchAdaptive(left, 1);
      const rightResults = await fetchBatchAdaptive(right, 1);
      return [...leftResults, ...rightResults];
    }

    throw err;
  }
}

function validateRunQuality(summary) {
  const reasons = [];

  if (summary.successRate < MIN_SUCCESS_RATE) {
    reasons.push(`取得成功率が低すぎます: ${summary.successRate.toFixed(4)} < ${MIN_SUCCESS_RATE}`);
  }

  if (summary.errorCount > MAX_ERROR_COUNT) {
    reasons.push(`失敗件数が多すぎます: ${summary.errorCount} > ${MAX_ERROR_COUNT}`);
  }

  if (summary.rateLimitCount > MAX_429_COUNT) {
    reasons.push(`429件数が多すぎます: ${summary.rateLimitCount} > ${MAX_429_COUNT}`);
  }

  return reasons;
}

async function main() {
  ensureOutputDir();
  clearOldOutputFiles();

  const runId = buildRunId();
  const summaryJsonPath = outPath(`${OUTPUT_BASENAME}_summary.json`);
  const failuresJsonPath = outPath(`${OUTPUT_BASENAME}_failures.json`);
  const runLogPath = logPath(`build_watchlists_${runId}.log`);

  log("JPXの上場銘柄一覧を取得中...");
  const workbook = await downloadJpxWorkbook();

  log("TradingView用銘柄リストを抽出中...");
  const tvSymbols = extractTradingViewSymbolsFromWorkbook(workbook);
  const mapped = tvSymbols.map(tvToYahoo);

  log(`抽出銘柄数: ${tvSymbols.length}`);

  const dailyCache = loadDailyCache();
  const cacheData = dailyCache.data;

  const rows = [];

  const cachedRows = [];
  const pending = [];

  for (const item of mapped) {
    const cached = cacheData[item.yahooSymbol];
    if (
      cached &&
      (cached.previous_close !== null || cached.volume !== null)
    ) {
      cachedRows.push({
        tv_symbol: item.tvSymbol,
        yahoo_symbol: item.yahooSymbol,
        previous_close: cached.previous_close,
        volume: cached.volume,
      });
    } else {
      pending.push(item);
    }
  }

  rows.push(...cachedRows);
  log(`キャッシュヒット: ${cachedRows.length}`);
  log(`Yahoo取得対象: ${pending.length}`);

  const chunks = chunkArray(pending, INITIAL_BATCH_SIZE);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const from = i * INITIAL_BATCH_SIZE + 1;
    const to = i * INITIAL_BATCH_SIZE + chunk.length;

    log(`前日終値/出来高取得中: ${from} - ${to} / ${pending.length}`);

    try {
      const batchRows = await fetchBatchAdaptive(chunk);

      for (const row of batchRows) {
        rows.push(row);
        cacheData[row.yahoo_symbol] = {
          previous_close: row.previous_close,
          volume: row.volume,
        };
      }

      saveDailyCache(dailyCache.file, cacheData);
    } catch (err) {
      if (isRateLimitError(err)) {
        rateLimitCount += 1;
      }

      for (const item of chunk) {
        if (errorCount < MAX_ERROR_LOGS) {
          log(`取得失敗: ${item.yahooSymbol} / ${err.message}`);
        } else if (errorCount === MAX_ERROR_LOGS) {
          log("取得失敗ログが多いため、以降は省略します。");
        }

        errorCount += 1;
        failureDetails.push({
          yahoo_symbol: item.yahooSymbol,
          tv_symbol: item.tvSymbol,
          reason: String(err.message || err),
        });

        rows.push({
          tv_symbol: item.tvSymbol,
          yahoo_symbol: item.yahooSymbol,
          previous_close: null,
          volume: null,
        });
      }
    }

    if (i < chunks.length - 1) {
      await sleepWithJitter(BASE_SLEEP_MS);
    }
  }

  saveDailyCache(dailyCache.file, cacheData);

  const filteredRows = rows.filter(
    (row) => row.previous_close !== null && row.previous_close <= PRICE_THRESHOLD
  );

  let outputRows = [...filteredRows];
  let cappedByVolume = false;

  if (outputRows.length > MAX_TOTAL_SYMBOLS) {
    outputRows.sort((a, b) => {
      const volA = Number.isFinite(a.volume) ? a.volume : -1;
      const volB = Number.isFinite(b.volume) ? b.volume : -1;
      if (volB !== volA) return volB - volA;
      return a.previous_close - b.previous_close;
    });
    outputRows = outputRows.slice(0, MAX_TOTAL_SYMBOLS);
    cappedByVolume = true;
  } else {
    outputRows.sort((a, b) => a.previous_close - b.previous_close);
  }

  const outputChunks = chunkArray(outputRows, MAX_SYMBOLS_PER_FILE).slice(0, MAX_WATCHLIST_FILES);

  outputChunks.forEach((chunk, index) => {
    const fileName = buildOutputFileName(index);
    writeTxt(fileName, chunk.map((row) => row.tv_symbol));
    log(`出力TXT: ${OUTPUT_DIR}/${fileName} (${chunk.length}銘柄)`);
  });

  writeCsv(`${OUTPUT_BASENAME}.csv`, outputRows);

  const successCount = rows.filter((row) => row.previous_close !== null).length;
  const successRate = mapped.length === 0 ? 0 : successCount / mapped.length;

  const summary = {
    runId,
    universeCount: tvSymbols.length,
    fetchedCount: successCount,
    filteredCount: filteredRows.length,
    outputRows: outputRows.length,
    splitCount: outputChunks.length,
    cappedByVolume,
    errorCount,
    rateLimitCount,
    successRate,
    cacheHitCount: cachedRows.length,
    yahooFetchTargetCount: pending.length,
    thresholds: {
      MIN_SUCCESS_RATE,
      MAX_ERROR_COUNT,
      MAX_429_COUNT,
    },
  };

  writeJson(summaryJsonPath, summary);
  writeJson(failuresJsonPath, failureDetails);
  fs.writeFileSync(runLogPath, runLogs.join("\n"), "utf8");

  log("---");
  log(`母集団銘柄数: ${tvSymbols.length}`);
  log(`前日終値を取得できた銘柄数: ${successCount}`);
  log(`${PRICE_THRESHOLD}円以下の抽出件数: ${filteredRows.length}`);
  log(`最終出力件数: ${outputRows.length}`);
  log(`分割数: ${outputChunks.length}`);
  log(`出来高上位2000件制限: ${cappedByVolume ? "ON" : "OFF"}`);
  log(`失敗件数: ${errorCount}`);
  log(`429件数: ${rateLimitCount}`);
  log(`成功率: ${(successRate * 100).toFixed(2)}%`);
  log(`CSV: ${OUTPUT_DIR}/${OUTPUT_BASENAME}.csv`);
  log(`SUMMARY JSON: ${summaryJsonPath}`);
  log(`FAILURES JSON: ${failuresJsonPath}`);
  log(`RUN LOG: ${runLogPath}`);

  const qualityErrors = validateRunQuality(summary);
  if (qualityErrors.length > 0) {
    throw new Error(`品質チェック失敗:\n- ${qualityErrors.join("\n- ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
