const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * rsi_analysis.js
 * Comprehensive technical analysis tool for RSI Range Shifts and Market Signals.
 * Updated with Exponential Backoff to handle API rate limiting (429 errors).
 */

const DEFAULT_TICKERS = {
    'ABB.ST': 'ABB', 'AZN.ST': 'AstraZeneca PLC', 'INVE-B.ST': 'Investor AB',
    'LUG.ST': 'Lundin Gold', 'LUMI.ST': 'Lundin Mining', 'NDA-SE.ST': 'Nordea',
    'SAAB-B.ST': 'Saab AB', 'SEB-A.ST': 'SEB', 'SHB-B.ST': 'Svenska Handelsbanken',
    'SWED-A.ST': 'Swedbank-A', 'VOLV-B.ST': 'Volvo-B', '^OMX': 'OMX Stockholm 30 Index', 'IBN': 'ICICI ADR'
};

// Console Colors
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

/**
 * Utility: Sleep for a given number of milliseconds
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


// Execute main
main().catch(err => console.error("Critical Failure:", err));

/**
 * Main execution function
 */
async function main() {
    const args = process.argv.slice(2);
    let endDateStr = args[0] || new Date().toISOString().split('T')[0];
    let tickerInput = args[1];

    if (!isValidDate(endDateStr)) {
        console.error("Invalid date format. Expected YYYY-MM-DD. Using current date.");
        endDateStr = new Date().toISOString().split('T')[0];
    }

    const endDate = new Date(endDateStr);
    endDate.setHours(23, 59, 59, 999);

    const tickers = tickerInput ? [tickerInput] : Object.keys(DEFAULT_TICKERS);
    const folderName = 'stock_data';

    if (!fs.existsSync(folderName)) {
        fs.mkdirSync(folderName);
    }

    const csvFileName = path.join(folderName, `RSI_Market_Analsys_${endDateStr}.csv`);
    const results = [];

    console.log(`\nMarket Analysis Report - End Date: ${endDateStr}`);
    console.log(`Source: Yahoo Finance API`);
    console.log(`Target Folder: ${folderName}\n`);

    for (const ticker of tickers) {
        try {
            process.stdout.write(`Analyzing ${ticker.padEnd(10)}... `);
            const analysis = await performAnalysis(ticker, endDate);
            if (analysis) {
                results.push(analysis);
                console.log('Completed.');
            } else {
                console.log('Skipped (No Data).');
            }
            await sleep(500); // Throttling
        } catch (err) {
            console.error(`${RED}Error: ${err.message}${RESET}`);
        }
    }

    if (results.length > 0) {
        generateCSV(results, csvFileName);
        printConsoleReport(results);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
//  Pretty printing function
// ─────────────────────────────────────────────────────────────────────────────
function printRSIRangeShiftResult(result) {
    if (!result.success) {
      console.log("┌──────────────────────────────────────────────────────┐");
      console.log("│                  DETECTION FAILED                    │");
      console.log("├──────────────────────────────────────────────────────┤");
      console.log(`│ Error: ${result.error}`);
      if (result.neededAtLeast) {
        console.log(`│ Needed at least: ${result.neededAtLeast} bars`);
        console.log(`│ Received:        ${result.received} bars`);
      }
      console.log("└──────────────────────────────────────────────────────┘");
      return;
    }
  
    const strengthColor = 
      result.strength === "high"    ? "\x1b[32m" :  // green
      result.strength === "medium"  ? "\x1b[33m" :  // yellow
      "\x1b[90m";                                   // gray
  
    const reset = "\x1b[0m";
  
    console.log("┌──────────────────────────────────────────────────────────────┐");
    console.log(`│ RSI BULLISH RANGE SHIFT ANALYSIS   |   ${result.date}     │`);
    console.log("├──────────────────────────────────────────────────────────────┤");
    console.log(`│ Regime      : ${strengthColor}${result.regime}${reset}`);
    console.log(`│ Strength    : ${strengthColor}${result.strength.toUpperCase()}${reset}`);
    console.log("│");
    console.log(`│ Current RSI : ${result.currentRSI.toFixed(2)}`);
    if (result.prevRSI !== null) {
      console.log(`│ Previous RSI: ${result.prevRSI.toFixed(2)}`);
    }
    console.log("│");
    console.log(`│ % above ${result.stats.barsAbove60 >= 68 ? "60" : "60"} : ${result.percentAbove60}%  (${result.stats.barsAbove60} bars)`);
    console.log(`│ % above 52  : ${result.percentAbove52}%  (${result.stats.barsAbove52} bars)`);
    console.log("│");
    console.log(`│ Higher RSI lows found (recent ${result.stats.lookbackBarsUsed} bars): ${result.higherRSILowsFound}`);
    
    if (result.recentRsiLows.length > 0) {
      console.log("│ Recent RSI lows (bars ago):");
      result.recentRsiLows.forEach(low => {
        console.log(`│   • ${low.barsAgo.toString().padStart(4)} bars ago → RSI ${low.rsi}`);
      });
    } else {
      console.log("│ No significant RSI lows detected in lookback period");
    }
    
    console.log("└──────────────────────────────────────────────────────────────┘");
  }


/**
 * Detects bullish RSI range shift using daily data and the provided calculateRSI function
 * @param {Array<Object>} dailyData - array of daily candles ({date?, close: number, ...})
 * @param {Object} [options] - configuration overrides
 * @returns {Object} detection result
 */
function detectBullishRSIRangeShift(dailyData, options = {}) {
    // ── Configuration (tuned for daily timeframe) ─────────────────────────────
    const config = {
      rsiPeriod: options.rsiPeriod ?? 14,
      lookbackBars: options.lookbackBars ?? 120,               // ~4 months
      bullishZoneThreshold: options.bullishZoneThreshold ?? 60,
      neutralLine: options.neutralLine ?? 52,
      minBullishBarsRequired: options.minBullishBarsRequired ?? 18,
      minHigherLowsCount: options.minHigherLowsCount ?? 2,
      rsiLowThreshold: options.rsiLowThreshold ?? 40,
      higherLowBuffer: options.higherLowBuffer ?? 1.2,         // RSI points
      ...options
    };
  
    // Basic validation
    if (!Array.isArray(dailyData) || dailyData.length < config.rsiPeriod + config.lookbackBars + 10) {
      return {
        success: false,
        error: "Not enough data",
        neededAtLeast: config.rsiPeriod + config.lookbackBars + 10,
        received: dailyData?.length ?? 0
      };
    }
  
    // Calculate RSI using your function
    const rsiValues = calculateRSI(dailyData, config.rsiPeriod);
  
    if (rsiValues.length === 0) {
      return { success: false, error: "RSI calculation returned empty array" };
    }
  
    // rsiValues[0] corresponds to the first RSI after initial period
    // Most recent values are at the end
    const currentRSI = rsiValues[rsiValues.length - 1];
    const prevRSI    = rsiValues.length >= 2 ? rsiValues[rsiValues.length - 2] : null;
  
    // Recent window for regime analysis
    const recentRSI = rsiValues.slice(-config.lookbackBars);
  
    if (recentRSI.length < 20) {
      return { success: false, error: "Not enough RSI values in lookback window" };
    }
  
    let aboveBullishZone = 0;
    let aboveNeutral     = 0;
    const rsiLows        = [];
  
    // ── Regime analysis + swing low detection ───────────────────────────────
    for (let i = 0; i < recentRSI.length; i++) {
      const val = recentRSI[i];
  
      if (val >= config.bullishZoneThreshold) aboveBullishZone++;
      if (val >= config.neutralLine) aboveNeutral++;
  
      // Detect local low (needs neighbors on both sides)
      if (i >= 2 && i < recentRSI.length - 2) {
        const isLocalLow =
          val <= recentRSI[i - 1] &&
          val <= recentRSI[i - 2] &&
          val <= recentRSI[i + 1] &&
          val <= recentRSI[i + 2] &&
          val <= config.rsiLowThreshold;
  
        if (isLocalLow) {
          rsiLows.push({
            relPos: i - (recentRSI.length - 1), // negative = how many bars ago
            value: val
          });
        }
      }
    }
  
    // Count higher lows
    let higherLowsCount = 0;
    if (rsiLows.length >= 2) {
      for (let i = 1; i < rsiLows.length; i++) {
        if (rsiLows[i].value > rsiLows[i - 1].value + config.higherLowBuffer) {
          higherLowsCount++;
        }
      }
    }
  
    const percentInBullishZone = (aboveBullishZone / recentRSI.length) * 100;
    const percentAboveNeutral  = (aboveNeutral     / recentRSI.length) * 100;
  
    // ── Decision rules ──────────────────────────────────────────────────────
    const isStrongShift =
      percentInBullishZone >= 68 &&
      percentAboveNeutral  >= 82 &&
      currentRSI > config.bullishZoneThreshold - 4 &&
      (prevRSI ?? 0) > config.neutralLine &&
      higherLowsCount >= config.minHigherLowsCount &&
      aboveBullishZone >= config.minBullishBarsRequired;
  
    const isDevelopingShift =
      !isStrongShift &&
      percentInBullishZone >= 55 &&
      percentAboveNeutral  >= 72 &&
      currentRSI > config.neutralLine + 4 &&
      higherLowsCount >= 1;
  
    // ── Result object ───────────────────────────────────────────────────────
    return {
      success: true,
      date: dailyData[dailyData.length - 1]?.date 
         || dailyData[dailyData.length - 1]?.time 
         || "latest",
      currentRSI: Number(currentRSI.toFixed(2)),
      prevRSI: prevRSI !== null ? Number(prevRSI.toFixed(2)) : null,
      percentAbove60: Number(percentInBullishZone.toFixed(1)),
      percentAbove52: Number(percentAboveNeutral.toFixed(1)),
      higherRSILowsFound: higherLowsCount,
      recentRsiLows: rsiLows.map(l => ({
        barsAgo: -l.relPos,
        rsi: Number(l.value.toFixed(1))
      })).slice(-5), // most recent 5 lows
      regime:
        isStrongShift    ? "STRONG BULLISH RANGE SHIFT DETECTED" :
        isDevelopingShift ? "DEVELOPING bullish range shift" :
        "No clear bullish RSI range shift",
      strength: isStrongShift ? "high" : isDevelopingShift ? "medium" : "low",
      stats: {
        lookbackBarsUsed: recentRSI.length,
        barsAbove60: aboveBullishZone,
        barsAbove52: aboveNeutral,
        totalRecentBars: recentRSI.length
      }
    };
  }
  


/**
 * Orchestrates technical analysis for multiple timeframes
 */
async function performAnalysis(ticker, endDate) {
    const dailyData = await fetchYahooData(ticker, endDate, '1d');
    if (!dailyData) return null;

    const analysis = detectBullishRSIRangeShift(dailyData);
    printRSIRangeShiftResult(analysis);

    const weeklyData = aggregateData(dailyData, 'weekly');
    const monthlyData = aggregateData(dailyData, 'monthly');

    const dailyRsiTrend = analyzeRsiTrend(dailyData   || [], 'Daily');
    const weeklyRsiTrend = analyzeRsiTrend(weeklyData  || [], 'Weekly');
    const monthlyRsiTrend = analyzeRsiTrend(monthlyData || [], 'Monthly');

    const dRsi = dailyRsiTrend.currentRsi;
    const wRsi = weeklyRsiTrend.currentRsi;
    const mRsi = monthlyRsiTrend.currentRsi;

    const dRsiTrend = dailyRsiTrend.trend;
    const wRsiTrend = weeklyRsiTrend.trend;
    const mRsiTrend = monthlyRsiTrend.trend;

    const dRsiDesc = dailyRsiTrend.description;
    const wRsiDesc = weeklyRsiTrend.description;
    const mRsiDesc = monthlyRsiTrend.description;

    const support = calculateSupport(dailyData);
    const resistance = calculateResistance(dailyData);
    const [pdi, mdi] = calculateDMI(dailyData, 14);

    const latest = dailyData[dailyData.length - 1];
    const prev1 = dailyData[dailyData.length - 2] || latest;
    const prev5 = dailyData[dailyData.length - 6] || dailyData[0];
    const prev10 = dailyData[dailyData.length - 11] || dailyData[0];

    const rsiSignal = determineRSISignal(dRsi, wRsi);
    const marketSignal = determineMarketSignal(dRsi, wRsi, rsiSignal);
    
    const stopLoss = support * 0.98;

    // Ordered as per user request
    return {
        Ticker: ticker,
        date: latest.date,
        open: round(latest.open),
        high: round(latest.high),
        low: round(latest.low),
        close: round(latest.close),
        Support: round(support),
        Resistance: round(resistance),
        DailyRSI: round(dRsi),
        WeeklyRSI: round(wRsi),
        MonthlyRSI: round(mRsi),
        'RSI Signal': rsiSignal,
        'MDI ': round(mdi),
        PDI: round(pdi),
        'Market Signal': marketSignal,
        Entry: round(latest.close),
        StopLoss: round(stopLoss),
        dRsiTrend: dRsiTrend,
        wRsiTrend: wRsiTrend,
        mRsiTrend: mRsiTrend,
        dRsiDesc: dRsiDesc,
        wRsiDesc: wRsiDesc,
        mRsiDesc: mRsiDesc,
        '1D % price change': perc(latest.close, prev1.close),
        '5D % price change': perc(latest.close, prev5.close),
        '10D % price change': perc(latest.close, prev10.close),
        '1D % Volume change': perc(latest.volume, prev1.volume),
        '5D % Volume change': perc(latest.volume, prev5.volume),
        '10D % Volume change': perc(latest.volume, prev10.volume)
    };
}

/**
 * Utility: Calculate start date (10 years lookback)
 */
function getStartDate(endDate = new Date()){
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 3650); 
    return startDate;
}

/**
 * Fetches JSON data from Yahoo Finance Chart API using axios with Exponential Backoff
 */
async function fetchYahooData(ticker, endDate, interval = '1d') {
    const period2 = Math.floor(endDate.getTime() / 1000);
    const startDate = getStartDate(endDate);
    const period1 = Math.floor(startDate.getTime() / 1000);

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=${interval}&includeAdjustedClose=true`;
    
    const maxRetries = 5;
    const retryDelays = [1000, 2000, 4000, 8000, 16000];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(url, { 
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' } 
            });
            const result = response.data.chart.result[0];
            if (!result || !result.timestamp) return null;

            const q = result.indicators.quote[0];
            let standard = result.timestamp.map((time, i) => ({
                date: new Date(time * 1000).toISOString().split('T')[0],
                timestamp: time * 1000,
                open: q.open[i], 
                high: q.high[i], 
                low: q.low[i], 
                close: q.close[i], 
                volume: q.volume[i]
            })).filter(c => c.open != null && c.close != null && c.high != null && c.low != null);
            
            return (standard.length < 20) ? null : standard;
        } catch (e) { 
            const isRateLimit = e.response && e.response.status === 429;
            if (isRateLimit && attempt < maxRetries) {
                await sleep(retryDelays[attempt]);
                continue;
            }
            return null; 
        }
    }
    return null;
}


/**
 * Calculates RSI(14) and determines the current trend based on your exact RSI range-shift rules
 * Works on ANY timeframe data (daily, weekly, monthly candles)
 * @param {Array<Object>} stockData - Array from fetchYahooData() 
 * @param {string} timeframeLabel - Optional label for logging/debug ("Daily", "Weekly", "Monthly")
 * @returns {Object} Trend classification
 */
function analyzeRsiTrend(stockData, timeframeLabel = 'Daily') {
    if (!Array.isArray(stockData) || stockData.length < 20) {
        return {
            trend: 'Insufficient Data',
            currentRsi: null,
            description: `Need at least 20 candles for reliable RSI(14) on ${timeframeLabel}`,
            timeframe: timeframeLabel
        };
    }

    const rsiValues = calculateRSI(stockData);

    if (rsiValues.length === 0) {
        return { trend: 'Insufficient Data', currentRsi: null, description: 'RSI calculation failed', timeframe: timeframeLabel };
    }

    const latestRsi = rsiValues[rsiValues.length - 1];
    const prevRsi   = rsiValues.length >= 2 ? rsiValues[rsiValues.length - 2] : latestRsi;

    // Tolerance for "touching" support/resistance
    const tolerance = 1.8;

    let trend = 'Sideways';
    let description = 'RSI between 40–59 → Sideways (avoid trading)';

    // ────────────────────────────────────────────────
    // Your exact rules implemented
    // ────────────────────────────────────────────────
    if (latestRsi >= 60) {
        // Bullish zone
        const near60 = Math.abs(latestRsi - 60) <= tolerance;
        const near65 = latestRsi >= 65;

        if (near65 || (prevRsi >= latestRsi && near60)) {
            trend = 'Strong Uptrend';
            description = 'RSI above 60 + support at/above 60 → Strong Bullish';
        } else {
            trend = 'Uptrend';
            description = 'RSI in 40–98 range → Bullish trend';
        }
    }
    else if (latestRsi <= 40) {
        // Bearish zone
        const near40 = Math.abs(latestRsi - 40) <= tolerance;
        const below39 = latestRsi <= 39;

        if (below39 || (prevRsi <= latestRsi && near40)) {
            trend = 'Strong Downtrend';
            description = 'RSI below 40 + support below 39 or rejection at 40 → Strong Bearish';
        } else {
            trend = 'Downtrend';
            description = 'RSI in 5–59 range → Bearish trend';
        }
    }
    else {
        // 40–59 zone → Sideways unless recent bounce/rejection
        if (Math.abs(latestRsi - 40) <= tolerance && latestRsi > prevRsi) {
            trend = 'Uptrend';
            description = 'RSI just found support at 40 → Bullish signal';
        }
        else if (Math.abs(latestRsi - 60) <= tolerance && latestRsi < prevRsi) {
            trend = 'Downtrend';
            description = 'RSI just rejected at 60 → Bearish signal';
        }
    }

    return {
        trend,
        currentRsi: Math.round(latestRsi * 100) / 100,
        description,
        timeframe: timeframeLabel,
        rsiValues: rsiValues  // useful for debugging/charts
    };
}

function calculateRSI(stockData, period = 14) {
    if (!Array.isArray(stockData) || stockData.length < period + 1) {
        return [];
    }

    // Extract close prices safely
    const closes = stockData
        .map(c => c.close)
        .filter(close => typeof close === 'number' && !isNaN(close));

    if (closes.length < period + 1) {
        return [];
    }

    const gains = [];
    const losses = [];

    // Calculate price changes
    for (let i = 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? Math.abs(change) : 0);
    }

    // Initial averages (simple moving average for first period)
    let avgGain = gains.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

    const rsi = [];

    // First RSI value
    let rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsi.push(100 - (100 / (1 + rs)));

    // Smoothed values using Wilder's method
    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

        rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
        const rsiValue = 100 - (100 / (1 + rs));
        rsi.push(rsiValue);
    }

    return rsi;
}


/**
 * Aggregates daily data into Weekly or Monthly intervals
 */
function aggregateData(data, type = 'weekly') {
    const aggregated = [];
    if (!Array.isArray(data) || data.length === 0) return aggregated;

    let currentGroup = null;

    data.forEach((day) => {
        const dateObj = new Date(day.timestamp);
        let groupId;
        
        if (type === 'weekly') {
            const tempDate = new Date(dateObj.getTime());
            const dayOfWeek = tempDate.getUTCDay(); 
            const diff = tempDate.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
            tempDate.setUTCDate(diff);
            groupId = tempDate.toISOString().split('T')[0];
        } else {
            groupId = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}`;
        }

        if (!currentGroup || currentGroup.id !== groupId) {
            if (currentGroup) aggregated.push(currentGroup);
            currentGroup = {
                id: groupId,
                open: day.open,
                high: day.high,
                low: day.low,
                close: day.close,
                date: day.date,
                timestamp: day.timestamp
            };
        } else {
            currentGroup.high = Math.max(currentGroup.high, day.high);
            currentGroup.low = Math.min(currentGroup.low, day.low);
            currentGroup.close = day.close;
        }
    });

    if (currentGroup) aggregated.push(currentGroup);
    return aggregated;
}

/**
 * DMI (Directional Movement Index) Calculation
 */
function calculateDMI(data, period) {
    if (data.length < period) return [0, 0];
    let tr = 0, pdm = 0, mdm = 0;
    
    for (let i = 1; i < data.length; i++) {
        const h = data[i].high, l = data[i].low, pc = data[i - 1].close;
        const ph = data[i - 1].high, pl = data[i - 1].low;
        
        tr += Math.max(h - l, Math.max(Math.abs(h - pc), Math.abs(l - pc)));
        const up = h - ph, down = pl - l;
        
        if (up > down && up > 0) pdm += up;
        if (down > up && down > 0) mdm += down;
    }
    
    const pdi = (pdm / tr) * 100;
    const mdi = (mdm / tr) * 100;
    return [pdi, mdi];
}

function calculateSupport(data) {
    return Math.min(...data.slice(-20).map(d => d.low));
}

function calculateResistance(data) {
    return Math.max(...data.slice(-20).map(d => d.high));
}

/**
 * Signals based on RSI Range Theory
 */
function determineRSISignal(dRsi, wRsi) {
    if (dRsi >= 60 && dRsi <= 98 && wRsi >= 60 && wRsi <= 98) return "Strong Bullish";
    if (dRsi >= 40 && dRsi < 60 && wRsi >= 40 && wRsi < 60) return "Bullish Range Shift";
    if (dRsi >= 5 && dRsi <= 39 && wRsi >= 5 && wRsi <= 39) return "Strong Bearish";
    if (dRsi > 39 && dRsi < 59 && wRsi > 39 && wRsi < 59) return "Bearish Range Shift";
    return "Sideways";
}

function determineMarketSignal(dRsi, wRsi, rsiSig) {
    if (rsiSig.includes("Bullish Range Shift") || (dRsi < 21 && wRsi < 30)) return "BUY";
    if (rsiSig.includes("Bearish Range Shift") || (dRsi > 75)) return "SELL";
    return "HOLD";
}

/**
 * Utility: Rounding
 */
function round(val) {
    if (val === null || val === undefined) return 0;
    return Math.round(val * 100) / 100;
}

/**
 * Utility: Formatting percentage strings
 */
function perc(curr, prev) {
    if (!prev || prev === 0) return "0.00%";
    const p = ((curr - prev) / prev) * 100;
    return `${p.toFixed(2)}%`;
}

function isValidDate(dateStr) {
    return !isNaN(Date.parse(dateStr));
}

/**
 * CSV Generation
 */
function generateCSV(results, filename) {
    if (results.length === 0) return;
    const headers = Object.keys(results[0]).join(',');
    const rows = results.map(row => {
        return Object.values(row).map(v => typeof v === 'string' ? `"${v}"` : v).join(',');
    });
    fs.writeFileSync(filename, [headers, ...rows].join('\n'));
    console.log(`\nCSV Exported to: ${filename}`);
}

/**
 * Console Output with Color formatting
 */
function printConsoleReport(results) {
    console.log("\n--- MARKET ANALYSIS SUMMARY ---");
    
    // Headers to display in terminal (subset of full data for readability)
    const displayHeaders = [
        "Ticker", "date", "close", "DailyRSI", "WeeklyRSI", 
        "1D % price change", "5D % price change", "Market Signal"
    ];

    const headerLine = displayHeaders.map(h => h.padEnd(16)).join(" | ");
    console.log(headerLine);
    console.log("-".repeat(headerLine.length));

    results.forEach(r => {
        const mSignal = r['Market Signal'];
        const mColor = mSignal === 'SELL' ? RED : (mSignal === 'BUY' ? GREEN : '');
        
        const line = displayHeaders.map(h => {
            let val = r[h].toString();
            // Apply Red to negative percentage values
            if (h.includes("%") && parseFloat(val) < 0) {
                return `${RED}${val.padEnd(16)}${RESET}`;
            }
            if (h === "Market Signal") {
                return `${mColor}${val.padEnd(16)}${RESET}`;
            }
            return val.padEnd(16);
        }).join(" | ");
        
        console.log(line);
    });
    console.log("\n(Full data points including Volume changes, MDI/PDI, and Support/Resistance are available in the CSV)\n");
}
