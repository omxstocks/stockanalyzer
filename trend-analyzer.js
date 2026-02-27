const axios = require('axios');
const fs = require('fs');
const path = require('path');

const outputFolder = 'stock_data';
if (!fs.existsSync(outputFolder + '/details')) {
    fs.mkdirSync(outputFolder + '/details', { recursive: true });
}

const colors = {
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    magenta: "\x1b[35m",
    bold: "\x1b[1m",
    reset: "\x1b[0m"
};

const TOTAL_CAPITAL = 20000;
const RISK_PERCENT = 0.01;
const JOURNAL_FILE = 'trading_journal.csv';

const DEFAULT_TICKERS = {
    'ABB.ST': 'ABB', 'AZN.ST': 'AstraZeneca PLC', 'INVE-B.ST': 'Investor AB',
    'LUG.ST': 'Lundin Gold', 'LUMI.ST': 'Lundin Mining', 'NDA-SE.ST': 'Nordea',
    'SAAB-B.ST': 'Saab AB', 'SEB-A.ST': 'SEB', 'SHB-B.ST': 'Svenska Handelsbanken',
    'SWED-A.ST': 'Swedbank-A', 'VOLV-B.ST': 'Volvo-B'
};

function isValidDate(dateString) {
    const regEx = /^\d{4}-\d{2}-\d{2}$/;
    if(!dateString || !dateString.match(regEx)) return false;
    const d = new Date(dateString);
    return d instanceof Date && !isNaN(d) && d.toISOString().startsWith(dateString);
}

const isWeekend = (date) => {
    const day = date.getDay();
    // 0 is Sunday, 6 is Saturday
    return day === 0 || day === 6;
  };

function round2(num) {
    if (num === null || num === undefined || isNaN(num)) return "N/A";
    return Number(num.toFixed(2));
}

/**
 * UPDATED: Keeps values clean. 
 * ANSI colors will now be applied only during console output.
 */
function formatValue(val) {
    if (val === null || val === undefined) return "N/A";
    return val;
}

// --- DATA AGGREGATION HELPERS ---
const aggregateData = (dailyData, timeframe) => {
    const aggregated = [];
    let current = null;

    dailyData.forEach((day) => {
        const date = new Date(day.date);
        let key;
        
        if (timeframe === 'weekly') {
            const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
            d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
            key = `${d.getUTCFullYear()}-W${Math.ceil((((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7)}`;
        } else {
            key = `${date.getFullYear()}-${date.getMonth()}`;
        }

        if (!current || current.key !== key) {
            if (current) aggregated.push(current.data);
            current = { key, data: { ...day } };
        } else {
            current.data.close = day.close;
            current.data.high = Math.max(current.data.high, day.high);
            current.data.low = Math.min(current.data.low, day.low);
            current.data.volume += day.volume;
        }
    });
    if (current) aggregated.push(current.data);
    return aggregated;
};

/*
// --- TECHNICAL CALCULATORS ---
function calculateDMI(std, buyPeriod = 5, sellPeriod = 14) {
    if (std.length < (sellPeriod * 2) + 1) return { pdi: 0, mdi: 0, adx: 0 };
    let trs = [], plusDMs = [], minusDMs = [];

    for (let i = 1; i < std.length; i++) {
        const current = std[i];
        const prev = std[i - 1];
        const tr = Math.max(current.high - current.low, Math.abs(current.high - prev.close), Math.abs(current.low - prev.close));
        const moveUp = current.high - prev.high;
        const moveDown = prev.low - current.low;
        plusDMs.push(moveUp > moveDown && moveUp > 0 ? moveUp : 0);
        minusDMs.push(moveDown > moveUp && moveDown > 0 ? moveDown : 0);
        trs.push(tr);
    }

    const smoothWilder = (data, p) => {
        let smoothed = [];
        let currentSmooth = data.slice(0, p).reduce((a, b) => a + b, 0);
        smoothed.push(currentSmooth);
        for (let i = p; i < data.length; i++) {
            currentSmooth = currentSmooth - (currentSmooth / p) + data[i];
            smoothed.push(currentSmooth);
        }
        return smoothed;
    };

    const sTR = smoothWilder(trs, sellPeriod);
    const sPlus = smoothWilder(plusDMs, buyPeriod);
    const sMinus = smoothWilder(minusDMs, sellPeriod);
    const pdiValues = sPlus.map((val, i) => sTR[i] === 0 ? 0 : (val / sTR[i]) * 100);
    const mdiValues = sMinus.map((val, i) => sTR[i] === 0 ? 0 : (val / sTR[i]) * 100);
    const dxValues = pdiValues.map((p, i) => {
        const m = mdiValues[i];
        const sum = p + m;
        return sum === 0 ? 0 : (Math.abs(p - m) / sum) * 100;
    });

    const adxValues = smoothWilder(dxValues, sellPeriod).map(val => val / sellPeriod);
    const adxGaugeSlope = getGaugeSlope(adxValues);
    const pdiGaugeSlope = getGaugeSlope(pdiValues);
    const mdiGaugeSlope = getGaugeSlope(mdiValues);

    let adxAndDmiSigmal = '';
    if("Rising Momentum" === adxGaugeSlope.description && "Rising Momentum" === pdiGaugeSlope.description) adxAndDmiSigmal = "BUY";
    if("Rising Momentum" === adxGaugeSlope.description && "Rising Momentum" === mdiGaugeSlope.description) adxAndDmiSigmal = "SELL";

    return {
        pdi: +pdiValues.at(-1).toFixed(2),
        mdi: +mdiValues.at(-1).toFixed(2),
        adx: +adxValues.at(-1).toFixed(2),
        adxIndicatorSlope: getIndicatorSlope(adxValues).state,
        adxGaugeSlope: adxGaugeSlope.description,
        pdiIndicatorSlope: getIndicatorSlope(pdiValues).state,
        pdiGaugeSlope: pdiGaugeSlope.description,
        mdiIndicatorSlope: getIndicatorSlope(mdiValues).state,
        mdiGaugeSlope: mdiGaugeSlope.description,
        adxAndDmiSigmal: adxAndDmiSigmal
    };
}

function getIndicatorSlope(values, dx = 14) {
    if (values.length < 14) return { error: "Insufficient data" };
    const dy = values[values.length - 1] - values[values.length - 14];
    return { state: (values[values.length - 1] > 20) ? "Positive Zone" : "Negative Zone" };
}

function getGaugeSlope(values, n = 14) {
    if (!values || values.length < 14) return { error: "Insufficient data" };
    const dy = values[values.length - 1] - values[values.length - n];
    return { description: dy > 0 ? "Rising Momentum" : "Falling Momentum" };
}
*/

    /**
     * Hybrid ADX Analysis Tool
     * BUY: Fast (5) Trigger
     * SELL/EXIT: Slow (14) Filter
     */
    function calculateDMI(std, buyPeriod = 5, sellPeriod = 5) {
        if (std.length < (sellPeriod * 2) + 10) return { signal: 'DATA_INSUFFICIENT' };

        let trs = [], plusDMs = [], minusDMs = [];

        // 1. Generate Raw Price Action Data
        for (let i = 1; i < std.length; i++) {
            const current = std[i];
            const prev = std[i - 1];

            const tr = Math.max(
                current.high - current.low,
                Math.abs(current.high - prev.close),
                Math.abs(current.low - prev.close)
            );

            const upMove = current.high - prev.high;
            const downMove = prev.low - current.low;

            plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
            trs.push(tr);
        }

        /**
         * Precision Wilder's Smoothing logic
         */
        const smoothWilder = (data, p) => {
            let smoothed = [];
            let firstSMA = data.slice(0, p).reduce((a, b) => a + b, 0);
            smoothed.push(firstSMA);

            let currentSmooth = firstSMA;
            for (let i = p; i < data.length; i++) {
                currentSmooth = currentSmooth - (currentSmooth / p) + data[i];
                smoothed.push(currentSmooth);
            }
            return smoothed;
        };

        // Helper to calculate ADX, +DI, and -DI for any period
        const getADXComponents = (period) => {
            const sTR = smoothWilder(trs, period);
            const sPlus = smoothWilder(plusDMs, period);
            const sMinus = smoothWilder(minusDMs, period);

            const pdi = sPlus.map((v, i) => (sTR[i] === 0 ? 0 : (v / sTR[i]) * 100));
            const mdi = sMinus.map((v, i) => (sTR[i] === 0 ? 0 : (v / sTR[i]) * 100));

            const dx = pdi.map((p, i) => {
                const m = mdi[i];
                const sum = p + m;
                return sum === 0 ? 0 : (Math.abs(p - m) / sum) * 100;
            });

            const adx = smoothWilder(dx, period).map(v => v / period);
            return { pdi, mdi, adx };
        };

        const fast = getADXComponents(buyPeriod);
        const slow = getADXComponents(sellPeriod);

        // Current Values
        const currentFastADX = fast.adx.at(-1);
        const currentSlowADX = slow.adx.at(-1);
        const prevSlowADX = slow.adx.at(-2);
        const currentPDI = slow.pdi.at(-1);
        const currentMDI = slow.mdi.at(-1);

        // 2. Trend Health Logic
        let trendHealth = "SIDEWAYS";
        if (currentSlowADX < 20) {
            trendHealth = "QUIET / ACCUMULATION";
        } else if (currentSlowADX >= 20 && currentSlowADX < 40) {
            trendHealth = currentSlowADX > prevSlowADX ? "STRENGTHENING TREND" : "WEAKENING TREND";
        } else if (currentSlowADX >= 40) {
            trendHealth = currentSlowADX > prevSlowADX ? "POWER TREND (VERTICAL)" : "OVEREXTENDED / EXHAUSTING";
        }

        // 3. Signal Logic
        let signal = '';
        const fastAdxRising = fast.adx.at(-1) > fast.adx.at(-2);
        const fastPdiRising = fast.pdi.at(-1) > fast.pdi.at(-2);

        // BUY: Fast ADX crosses 25 AND is rising AND +DI dominates
        if (currentFastADX > 25 && fastAdxRising && fastPdiRising && fast.pdi.at(-1) > fast.mdi.at(-1)) {
            signal = "BUY";
        }

        // SELL: Slow ADX begins to fall (Trend Failure) OR -DI overtakes +DI
        if (currentSlowADX < prevSlowADX || currentMDI > currentPDI) {
            signal = "SELL";
        }

        return {
            pdi: +currentPDI.toFixed(2),
            mdi: +currentMDI.toFixed(2),
            adx: +currentSlowADX.toFixed(2),
            trendHealth: trendHealth,
            adxAndDmiSigmal: signal,
            fastADX: +currentFastADX.toFixed(2)
        };
    }

    function getIndicatorSlope(values) {
        if (values.length < 2) return { state: 'FLAT' };
        const current = values.at(-1);
        const previous = values.at(-2);
        
        if (current > previous) return { state: 'UP' };
        if (current < previous) return { state: 'DOWN' };
        return { state: 'FLAT' };
    }

    function getGaugeSlope(values) {
        if (values.length < 2) return { description: 'Neutral' };
        const current = values.at(-1);
        const previous = values.at(-2);

        if (current > previous) return { description: 'Rising Momentum' };
        if (current < previous) return { description: 'Falling Momentum' };
        return { description: 'Stable' };
    }

const getMultiTimeframeDMI = (standard, weeklyData, monthlyData) => {
    if (!standard || standard.length < 40) return null;
    return { 
        daily: calculateDMI(standard), 
        weekly: calculateDMI(weeklyData), 
        monthly: calculateDMI(monthlyData) };
};

const calculateSwingLevels = (data, period = 20) => {
    if (data.length < period) return { high: null, low: null };
    const slice = data.slice(-period);
    return { high: Math.max(...slice.map(d => d.high)), low: Math.min(...slice.map(d => d.low)) };
};

const calculateSupertrend = (data, atrPeriod = 10, multiplier = 3) => {
    if (data.length <= atrPeriod) return null;
    let trs = [data[0].high - data[0].low];
    for (let i = 1; i < data.length; i++) {
        trs.push(Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i - 1].close), Math.abs(data[i].low - data[i - 1].close)));
    }
    let atrs = new Array(data.length).fill(0);
    let sumTR = trs.slice(0, atrPeriod).reduce((a, b) => a + b, 0);
    atrs[atrPeriod - 1] = sumTR / atrPeriod;
    for (let i = atrPeriod; i < data.length; i++) atrs[i] = (atrs[i - 1] * (atrPeriod - 1) + trs[i]) / atrPeriod;

    let trend = 1, finalUpper = 0, finalLower = 0, supertrends = new Array(data.length).fill(null);
    for (let i = 0; i < data.length; i++) {
        if (i < atrPeriod) continue;
        const mid = (data[i].high + data[i].low) / 2;
        const basicUpper = mid + multiplier * atrs[i];
        const basicLower = mid - multiplier * atrs[i];
        if (i > atrPeriod) {
            finalUpper = (basicUpper < finalUpper || data[i - 1].close > finalUpper) ? basicUpper : finalUpper;
            finalLower = (basicLower > finalLower || data[i - 1].close < finalLower) ? basicLower : finalLower;
            if (trend === 1 && data[i].close < finalLower) trend = -1;
            else if (trend === -1 && data[i].close > finalUpper) trend = 1;
        } else { finalUpper = basicUpper; finalLower = basicLower; }
        supertrends[i] = trend === 1 ? finalLower : finalUpper;
    }
    return supertrends[supertrends.length - 1];
};

const calculateBollingerBands = (data, period = 20, multiplier = 2) => {
    if (data.length < period) return null;
    const slice = data.slice(-period).map(d => d.close);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return { upper: sma + (multiplier * stdDev), lower: sma - (multiplier * stdDev), mid: sma };
};

function getBollingerStrategy(data, bb, swingPeriod = 5) {
    const last = data.length - 1;
    const currentClose = data[last].close;
    const lowerBand = bb.lower;
    const recentCandles = data.slice(-swingPeriod);
    const swingLow = Math.min(...recentCandles.map(c => c.low));
    const isBuySignal = (lowerBand / currentClose) >= 0.95;
    if (isBuySignal) {
        const floorPrice = Math.min(swingLow, lowerBand);
        const stopLoss = floorPrice * 0.995; 
        return { signal: "BUY", entry: currentClose, bbLow: lowerBand, swingLow: round2(swingLow), stopLoss: stopLoss.toFixed(2), target: bb.mid.toFixed(2) };
    }
    return { signal: "HOLD", entry: currentClose, bbLow: lowerBand };
}

const calculateATR = (data, period = 14) => {
    if (data.length <= period) return null;
    let trs = [];
    for (let i = 1; i < data.length; i++) {
        trs.push(Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i - 1].close), Math.abs(data[i].low - data[i - 1].close)));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
};



function calculateMFI(std, period = 14) {
    if (std.length <= period) return 0;
    let posFlow = 0, negFlow = 0;
    const slices = std.slice(-(period + 1));
    for (let i = 1; i < slices.length; i++) {
        const tp = (slices[i].high + slices[i].low + slices[i].close) / 3;
        const prevTp = (slices[i-1].high + slices[i-1].low + slices[i-1].close) / 3;
        const rawFlow = tp * slices[i].volume;
        if (tp > prevTp) posFlow += rawFlow; else negFlow += rawFlow;
    }
    return 100 - (100 / (1 + (posFlow / negFlow)));
}

const calculateSMA = (data, period) => {
    if (data.length < period) return null;
    return data.slice(-period).reduce((sum, val) => sum + val.close, 0) / period;
};


const getMultiTimeframeRSI = (standard, weeklyData, monthlyData, period = 14) => {
    if (!standard || standard.length < 14) return null;
    return {
        daily: +calculateWildersRSI(standard, period).at(-1)?.rsi ?? "N/A",
        weekly: +calculateWildersRSI(weeklyData, period).at(-1)?.rsi ?? "N/A",
        monthly: +calculateWildersRSI(monthlyData, period).at(-1)?.rsi ?? "N/A"
    };
};

const calculateWildersRSI = (data, period = 14) => {
    if (data.length <= period) return [];
    let gains = 0, losses = 0, results = [];
    for (let i = 1; i <= period; i++) {
        const diff = data[i].close - data[i - 1].close;
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    const pushResult = (date) => {
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        results.push({ date, rsi: (100 - (100 / (1 + rs))).toFixed(2) });
    };
    pushResult(data[period].date);
    for (let i = period + 1; i < data.length; i++) {
        const diff = data[i].close - data[i - 1].close;
        avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
        pushResult(data[i].date);
    }
    return results;
};


    function getConfirmationMetrics(std) {
        const volumes = std.map(d => d.volume);
        const closes = std.map(d => d.close);

        // volRatio: Current / 20-day Avg
        const currentVol = volumes[volumes.length - 1];
        const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
        const volRatio = currentVol / avgVol;

        // Price vs 50-day SMA
        const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
        const priceAboveSMA50 = closes[closes.length - 1] > sma50;

        return { volRatio, priceAboveSMA50 };
    }

/**
 * 4. V4 SWING ENGINE LOGIC
 */
 function getActionSignal(dRsi, wRsi, mRsi, volRatio, priceAboveSMA50) {
    
    // Thresholds
    const BULL_ZONE = 50;
    const BUFFER = 5; // RSI must be 55 to be "Confirmed Bullish"
    const VOL_CONFIRM = 1.2; // 20% higher than average volume
    const OVERBOUGHT = 70;

    // Macro Trend Check (The Monthly Gatekeeper)
    const isMacroBullish = mRsi > BULL_ZONE;

    // A. Confirmed Breakout (All systems GO)
    if (dRsi > (BULL_ZONE + BUFFER) && wRsi > BULL_ZONE && isMacroBullish && priceAboveSMA50) {
        if (volRatio >= VOL_CONFIRM) {
            return { status: "CONFIRMED BREAKOUT", action: "STRONG BUY / HOLD", confidence: "HIGH" };
        }
        return { status: "WEAK BREAKOUT", action: "WAIT FOR VOLUME", confidence: "LOW" };
    }

    // B. Healthy Pullback (Swing Trader's Sweet Spot)
    if (isMacroBullish && wRsi > BULL_ZONE && dRsi < BULL_ZONE && priceAboveSMA50) {
        return { status: "HEALTHY PULLBACK", action: "ACCUMULATE (BUY DIP)", confidence: "MEDIUM-HIGH" };
    }

    // C. The Macro Fakeout (Daily looks good, but Monthly is Bearish)
    if (dRsi > BULL_ZONE && !isMacroBullish) {
        return { status: "MACRO TRAP", action: "AVOID / DO NOT BUY", confidence: "N/A" };
    }

    // D. Bear Market Rally (Price below 50-SMA)
    if (dRsi > BULL_ZONE && !priceAboveSMA50) {
        return { status: "BEAR MARKET RALLY", action: "STAY IN CASH", confidence: "N/A" };
    }

    // E. Overextended
    if (dRsi > OVERBOUGHT && wRsi > OVERBOUGHT) {
        return { status: "OVEREXTENDED", action: "TAKE PROFITS", confidence: "N/A" };
    }

    return { status: "NEUTRAL", action: "WAIT FOR SETUP", confidence: "N/A" };
 }


async function getStockData(ticker, period1, period2) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d`;
    try {
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const result = response.data.chart.result[0];
        const q = result.indicators.quote[0];
        let standard = result.timestamp.map((time, i) => ({
            date: new Date(time * 1000).toISOString().split('T')[0],
            open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i]
        })).filter(c => c.open && c.close && c.high && c.low);
        return (standard.length < 200) ? null : { standard };
    } catch (e) { return null; }
}

function analyze(data, symbol, name, period2) {
    const std = data.standard, weeklyStd = aggregateData(std, 'weekly'), monthlyStd = aggregateData(std, 'monthly');
    const last = std.length - 1;
    const c = std[last];
    const bb = calculateBollingerBands(std, 20, 2);
    const atr = calculateATR(std, 14);
    const rsi = getMultiTimeframeRSI(std, weeklyStd, monthlyStd, 14);
    const dmi = getMultiTimeframeDMI(std, weeklyStd, monthlyStd);
    const sma20 = calculateSMA(std, 20);
    const sma50 = calculateSMA(std, 50);
    const sma150 = calculateSMA(std, 150);
    const { volRatio, priceAboveSMA50 } = getConfirmationMetrics(std);

    const rsiTrend = getActionSignal(rsi.daily, rsi.weekly, rsi.monthly, volRatio, priceAboveSMA50);

    const calculateAvg = (arr, period, key) => {
        if (arr.length < period) return null;
        const slice = arr.slice(-period);
        return slice.reduce((acc, curr) => acc + (key === 'spread' ? curr.high - curr.low : curr[key]), 0) / period;
    };

    const avgSpread2W = calculateAvg(std, 10, 'spread');
    const avgSpread10W = calculateAvg(std, 50, 'spread');
    const avgVol2W = calculateAvg(std, 15, 'volume');
    const avgVol10W = calculateAvg(std, 50, 'volume');
    const diffBBLow = bb ? ((c.close - bb.lower) / bb.lower) * 100 : 0, diffBBHigh = bb ? ((c.close - bb.upper) / bb.upper) * 100 : 0;
    const entry = (std[last-3].open + std[last-3].high + std[last-3].low + std[last-3].close)/4; 
    const stop = entry - (atr * 2);
    const target = entry + (atr * 3.0);
    const riskPerShare = entry - stop;

    return {
        Date: c.date, Ticker: symbol, Close: round2(c.close),
        BBHigh: bb ? round2(bb.upper) : "N/A", BBLow: bb ? round2(bb.lower) : "N/A",
        Supertrend: round2(calculateSupertrend(std, 10, 3)), ATR: round2(atr),
        RsiD: rsi.daily, RsiW: rsi.weekly, RsiM: rsi.monthly,
        DmiD: dmi.daily, DmiW: dmi.weekly, DmiM: dmi.monthly,
        SwingHigh: round2(calculateSwingLevels(std, 20).high), SwingLow: round2(calculateSwingLevels(std, 20).low),
        vsaDPrice: (c.high - c.low > 1.5 * avgSpread2W) ? "High" : "Neutral", vsaWPrice: (c.high - c.low > 1.5 * avgSpread10W) ? "High" : "Neutral",
        vsaDVol: (c.volume > 1.5 * avgVol2W) ? "High" : "Neutral", vsaWVol: (c.volume > 1.5 * avgVol10W) ? "High" : "Neutral",
        Sma20: round2(sma20), Sma50: round2(sma50), Sma150: round2(sma150),
        RSITrend: rsiTrend.action,
        PriceTrend: (c.close > sma20 && sma20 > sma50 && sma50 > sma150) ? "Strong Uptrend" : "Mixed",
        "Diff_BBLow_%": round2(diffBBLow), "Diff_BBHigh_%": round2(diffBBHigh),
        entry: round2(entry), stop: round2(stop), target: round2(target),
        shares: riskPerShare > 0 ? Math.floor((TOTAL_CAPITAL * RISK_PERCENT) / riskPerShare) : 0
    };
}

async function newFunction(endDateInput, intervalYears, customTickers, signals) {
    const endDate = endDateInput ? new Date(endDateInput + 'T23:59:59') : new Date();
    const period2 = Math.floor(endDate.getTime() / 1000);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - Math.ceil(intervalYears * 365.25) - 300);
    const period1 = Math.floor(startDate.getTime() / 1000);

    const targetTickers = customTickers.length > 0 ? Object.fromEntries(customTickers.map(t => [t.toUpperCase(), t.toUpperCase()])) : DEFAULT_TICKERS;
    for (const [symbol, name] of Object.entries(targetTickers)) {
        const data = await getStockData(symbol, period1, period2);
        if (data) {
            const result = analyze(data, symbol, name, period2);
            if (result) signals.push(result);
        }
    }
}

async function run() {
    const args = process.argv.slice(2);
    let endDateInput = null, customTickers = [], backtest = "NO";
    if (args.length > 0) {
        if (args[0] === "YES" || args[0] === "NO") {
            backtest = args[0];
            if (isValidDate(args[1])) { endDateInput = args[1]; customTickers = args.slice(2); }
            else { customTickers = args.slice(1); }
        } else if (isValidDate(args[0])) {
            endDateInput = args[0]; customTickers = args.slice(1);
        } else { customTickers = args; }
    }

    const endDate = endDateInput ? new Date(endDateInput + 'T23:59:59') : new Date();

    if(isWeekend(endDate)){
        console.log("-".repeat(50));
        console.log("\n\nPlease choose a Week-Day. Stockmarket is not open in weekends.\n\n");
        console.log("-".repeat(50));
        return;
    }


    const endDateString = endDate.toISOString().split('T')[0];
    let signals = [];

    if(backtest === "YES"){
        let tradingDate = new Date(Date.UTC(endDate.getFullYear(), endDate.getUTCMonth(), 1));
        while(tradingDate.getUTCMonth() === endDate.getUTCMonth() && endDate.getTime() >= tradingDate.getTime()){
            if(tradingDate.getUTCDay() !== 0 && tradingDate.getUTCDay() !== 6) {
                await newFunction(tradingDate.toISOString().split('T')[0], 2, customTickers, signals);
            }
            tradingDate.setUTCDate(tradingDate.getUTCDate() + 1);
        }
    } else { await newFunction(endDateInput, 2, customTickers, signals); }
    
    signals.sort((a, b) => new Date(a.Date) - new Date(b.Date));

    if (signals.length > 0) {
        const common = s => ({ Date: s.Date, Ticker: s.Ticker });
        const groupConfigs = [
            { title: "Technical Indicators", color: colors.cyan, mapper: s => ({ ...common(s), Close: formatValue(s.Close), BBHigh: formatValue(s.BBHigh), BBLow: formatValue(s.BBLow), Supertrend: formatValue(s.Supertrend), ATR: formatValue(s.ATR), RsiD: formatValue(s.RsiD), RsiW: formatValue(s.RsiW), RsiM: formatValue(s.RsiM), SwingHigh: formatValue(s.SwingHigh), SwingLow: formatValue(s.SwingLow), Sma20: formatValue(s.Sma20), Sma50: formatValue(s.Sma50), Sma150: formatValue(s.Sma150) }) },
            { title: "Trend & VSA Analysis", color: colors.magenta, mapper: s => ({ ...common(s), Close: formatValue(s.Close), "Diff_BBLow_%": s["Diff_BBLow_%"], "Diff_BBHigh_%": s["Diff_BBHigh_%"], VsaDPrice: s.vsaDPrice, VsaWPrice: s.vsaWPrice, VsaDVol: s.vsaDVol, VsaWVol: s.vsaWVol }) },
            { title: "Entry Target & SL", color: colors.magenta, mapper: s => ({ ...common(s), entry: s.entry, target: s.target, stopLoss: s.stop, shares: s.shares,
                                            AdxD: s.DmiD.adx, PdiD: s.DmiD.pdi, MdiD: s.DmiD.mdi, adxAndDmiSigmal: s.DmiD.adxAndDmiSigmal, RSITrend: s.RSITrend, PriceTrend: s.PriceTrend }) }
        ];

        // 1. Process Individual Groups
        groupConfigs.forEach((group, index) => {
            const cleanData = signals.map(group.mapper);
            const coloredData = cleanData.map(row => {
                const newRow = { ...row };
                Object.keys(newRow).forEach(key => {
                    const val = parseFloat(newRow[key]);
                    if (!isNaN(val) && val < 0) newRow[key] = `${newRow[key]}`;
                });
                return newRow;
            });

            console.log(`\n${colors.bold}${group.color}--- Group ${index + 1}: ${group.title} ---${colors.reset}`);
            console.table(coloredData);

            const filePath = path.join(outputFolder + '/details', `${endDateString}_Group_${index + 1}_${group.title.replace(/\s+/g, '_')}.csv`);
            fs.writeFileSync(filePath, convertToCSV(cleanData));
        });

        // 2. CREATE CONSOLIDATED MASTER FILE (EVERY FIELD)
        const consolidatedData = signals.map(s => ({
            Date: s.Date,
            Ticker: s.Ticker,
            Close: s.Close,
            BBHigh: s.BBHigh,
            BBLow: s.BBLow,
           // Supertrend: s.Supertrend,
            ATR: s.ATR,
            RsiD: s.RsiD,
            RsiW: s.RsiW,
            RsiM: s.RsiM,
            Sma20: s.Sma20,
            Sma50: s.Sma50,
            Sma150: s.Sma150,
            SwingHigh: s.SwingHigh,
            SwingLow: s.SwingLow,
            "Diff_BBLow_%": s["Diff_BBLow_%"],
            "Diff_BBHigh_%": s["Diff_BBHigh_%"],
            VsaDPrice: s.vsaDPrice,
            VsaWPrice: s.vsaWPrice,
            VsaDVol: s.vsaDVol,
            VsaWVol: s.vsaWVol,
            RSITrend: s.RSITrend,
            PriceTrend: s.PriceTrend,
            Entry: s.entry,
            Target: s.target,
            StopLoss: s.stop,
            Shares: s.shares,
            // Daily DMI Fields
            Adx_D: s.DmiD.adx,
            Pdi_D: s.DmiD.pdi,
            Mdi_D: s.DmiD.mdi,
            Market_Decision: s.DmiD.adxAndDmiSigmal,
            // Weekly DMI Fields
            Adx_W: s.DmiW.adx,
            Pdi_W: s.DmiW.pdi,
            Mdi_W: s.DmiW.mdi
        }));

        const groupedByDate = consolidatedData.reduce((acc, current) => {
            const date = current.Date;
            
            // If the date group doesn't exist, create it
            if (!acc[date]) {
              acc[date] = [];
            }
            
            // Push the current item into the specific date group
            acc[date].push(current);
            
            return acc;
          }, {});

          processAndSaveTradingData(consolidatedData);

        // const consolidatedPath = path.join(outputFolder, `${endDateString}_Consolidated_Report.csv`);
        // fs.writeFileSync(consolidatedPath, convertToCSV(consolidatedData));
<<<<<<< Updated upstream
        console.log(`\n${colors.green}${colors.bold}✔ CONSOLIDATED MASTER REPORT SAVED: ${new Date()}${colors.reset}`);
=======
         console.log(`\n${colors.green}${colors.bold}✔ CONSOLIDATED MASTER REPORT SAVED: ${new Date()}${colors.reset}`);
>>>>>>> Stashed changes


    } else { console.log("No data available for Date: " + endDateString); }
}

const convertToCSV = (data) => {
    if (data.length === 0) return '';
    const headers = Object.keys(data[0]);
    const rows = data.map(obj => headers.map(h => (typeof obj[h] === 'string' && obj[h].includes(',')) ? `"${obj[h]}"` : (obj[h] ?? '')).join(','));
    return [headers.join(','), ...rows].join('\n');
};


function processAndSaveTradingData(data) {
    // 1. Group the data by Date
    const grouped = data.reduce((acc, current) => {
      const date = current.Date.replace(/['"]+/g, ''); // Clean quotes if present
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(current);
      return acc;
    }, {});
  
    // 2. Iterate through each date group and create a CSV
    Object.keys(grouped).forEach(date => {
      const rows = grouped[date];
      if (rows.length === 0) return;
  
      // Extract headers from the keys of the first object
      const headers = Object.keys(rows[0]);
      const headerRow = headers.join(',');
  
      // Map rows to CSV format
      const csvRows = rows.map(row => {
        return headers.map(header => {
          let value = row[header];
  
          // Clean up strings (remove extra quotes)
          if (typeof value === 'string') {
            value = value.replace(/['"]+/g, '');
            // If value contains a comma, wrap it in double quotes for CSV safety
            if (value.includes(',')) {
              value = `"${value}"`;
            }
          }
          
          return value;
        }).join(',');
      });
  
      // Combine Header and Rows
      const csvContent = [headerRow, ...csvRows].join('\n');
  
      // 3. Define the file name and write to disk
      const fileName = `${date}_Consolidated_Report.csv`;
      const filePath = path.join(outputFolder, fileName);
  
      try {
        fs.writeFileSync(filePath, csvContent, 'utf8');
        console.log(`✅ File saved: ${fileName} (${rows.length} entries)`);
      } catch (err) {
        console.error(`❌ Error saving ${fileName}:`, err);
      }
    });
  }

run();
