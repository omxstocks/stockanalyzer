import os
import json
import time
import argparse
import requests
import pandas as pd

# Configuration
TICKERS = [

        "AAPL", "ABB.ST", "ADDT-B.ST", "ALFA.ST", "ASSA-B.ST", "ATCO-A.ST", "AZN.ST", "EPI-A.ST", "GOLDBEES.NS", "HDFCBANK.NS",
        "IBN", "ICICIBANK.NS", "INDU-C.ST", "INVE-A.ST", "INVE-B.ST", "LT.NS", "LUG.ST", "LUMI.ST", "MSFT", "NDA-SE.ST", 
        "NIFTYBEES.NS", "NVDA", "RELIANCE.NS", "SAAB-B.ST", "SAND.ST", "SEB-A.ST", "SHB-A.ST", "SHB-B.ST", "SKA-B.ST", "SKF-B.ST", 
        "SWED-A.ST", "TCS.NS", "TEL2-B.ST", "TELIA.ST", "VOLV-B.ST"
]

VOLUME_THRESHOLD_MULTIPLIER = 2.3
VOLUME_AVG_WINDOW = 21

# Mirrors the LLAMA Pine indicator's LOW marker (FIX #25/#29/#32): peak-to-trough drawdown
# check over a rolling lookback, deduped per "episode" (same reference peak) so a prolonged
# decline only re-alerts when it sets a genuinely new, deeper low.
LOW_DRAWDOWN_LOOKBACK = 60
LOW_DRAWDOWN_PCT = 10.0

# RSI alert: fires when RSI(RSI_PERIOD) falls by more than RSI_DROP_PCT% (relative, not
# absolute points) versus the previous trading date's RSI — a simple day-over-day momentum
# check, independent of the Volume/LOW-price signals (a ticker can trigger this alongside
# either of them in the same run).
RSI_PERIOD = 14
RSI_DROP_PCT = 25.0

FETCH_DAYS_BACK = 130  # calendar days of history (comfortably covers 60+ trading days)
REQUEST_TIMEOUT = 10
REQUEST_DELAY_SEC = 1.5

TODAY_STR = pd.Timestamp.today().strftime('%Y-%m-%d')

# Persists LOW-alert episode state across daily runs (a fresh process each run has no
# memory otherwise, so without this every qualifying day would re-alert as if it were new).
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "low_alert_state.json")

# Retrieve secrets from environment variables
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHANNEL_ID = os.getenv("TELEGRAM_CHAT_ID")


def parse_args():
    parser = argparse.ArgumentParser(description="Volume spike / LOW-price drawdown alert scanner.")
    parser.add_argument("--ticker", type=str, default=None,
                        help="Check only this ticker instead of the full TICKERS list.")
    parser.add_argument("--date", type=str, default=None,
                        help="Evaluate as of this date (YYYY-MM-DD) instead of today.")
    parser.add_argument("--no-telegram", action="store_true",
                        help="Skip posting to Telegram; only print the console report.")
    return parser.parse_args()


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                return json.load(f)
        except Exception as e:
            print(f"Warning: could not read state file, starting fresh: {e}")
    return {}


def save_state(state):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        print(f"Error saving state file: {e}")


def send_telegram_message(text):
    """Sends a single message to the configured Telegram channel."""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": CHANNEL_ID, "text": text, "parse_mode": "Markdown"}
    try:
        response = requests.post(url, json=payload, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
    except Exception as e:
        print(f"Error sending Telegram message: {e}")


def build_consolidated_message(volume_hits, low_hits, rsi_hits, ref_date=None):
    """Builds one Telegram message covering every alert from this run, instead of a
    separate message per ticker/condition. Console output uses print_console_report()
    instead — a bullet list doesn't read well as a wide monospace table on a phone."""
    ref_date = ref_date or TODAY_STR
    lines = [f"📊 *Alerts Summary for {ref_date}*"]

    if not volume_hits and not low_hits and not rsi_hits:
        lines.append("No volume, LOW-price, or RSI alerts triggered.")
        lines.append("ℹ️ Source: Yahoo Finance")
        return "\n".join(lines)

    if volume_hits:
        lines.append(f"\n🚨 *Volume Alerts ({len(volume_hits)})*")
        for h in volume_hits:
            trend_indicator = "🔴" if h["price_change_pct"] < 0 else "🟢"
            ticker_link = f"[{h['ticker']}](https://finance.yahoo.com/chart/{h['ticker']})"
            lines.append(
                f"• {ticker_link}: {h['current_price']:.2f} {trend_indicator} "
                f"({h['price_change_pct']:+.2f}%) — Vol *{h['ratio']:.2f}x* "
                f"(cur {int(h['current_volume']):,} vs {VOLUME_AVG_WINDOW}D avg {int(h['avg_volume']):,})"
            )

    if low_hits:
        lines.append(f"\n🔻 *LOW-Price Alerts ({len(low_hits)})*")
        for h in low_hits:
            ticker_link = f"[{h['ticker']}](https://finance.yahoo.com/chart/{h['ticker']})"
            lines.append(
                f"• {ticker_link}: Low {h['current_low']:.2f}, "
                f"{LOW_DRAWDOWN_LOOKBACK}-Bar High {h['peak_price']:.2f} (on {h['peak_date']}), "
                f"Drawdown *{-h['drawdown_pct']:.2f}%*"
            )

    if rsi_hits:
        lines.append(f"\n📉 *RSI Drop Alerts ({len(rsi_hits)})*")
        for h in rsi_hits:
            ticker_link = f"[{h['ticker']}](https://finance.yahoo.com/chart/{h['ticker']})"
            lines.append(
                f"• {ticker_link}: RSI {h['prev_rsi']:.2f} → {h['current_rsi']:.2f} "
                f"(Drop *{h['drop_pct']:.2f}%*)"
            )

    lines.append("\nℹ️ Source: Yahoo Finance")
    return "\n".join(lines)


def _print_bordered_table(df):
    """Renders a DataFrame with box-drawing borders (no extra dependency beyond pandas).
    First column left-aligned (ticker), the rest right-aligned (already-formatted numbers)."""
    headers = list(df.columns)
    rows = [[str(v) for v in row] for row in df.values.tolist()]
    widths = [max(len(headers[i]), *(len(r[i]) for r in rows)) for i in range(len(headers))]
    aligns = ["l"] + ["r"] * (len(headers) - 1)

    def border(left, mid, right):
        return left + mid.join("─" * (w + 2) for w in widths) + right

    def row_line(cells):
        parts = [
            f" {c.ljust(w) if a == 'l' else c.rjust(w)} "
            for c, w, a in zip(cells, widths, aligns)
        ]
        return "│" + "│".join(parts) + "│"

    print(border("┌", "┬", "┐"))
    print(row_line(headers))
    print(border("├", "┼", "┤"))
    for r in rows:
        print(row_line(r))
    print(border("└", "┴", "┘"))


def print_console_report(volume_hits, low_hits, rsi_hits, ref_date=None):
    """Prints each alert category as an aligned table, one per section, using pandas
    (already a dependency) instead of Markdown bullets — reads far better in a terminal."""
    ref_date = ref_date or TODAY_STR
    print(f"\n=== Alerts Summary for {ref_date} ===")

    if not volume_hits and not low_hits and not rsi_hits:
        print("No volume, LOW-price, or RSI alerts triggered.\n")
        return

    if volume_hits:
        df = pd.DataFrame([{
            "Ticker": h["ticker"],
            "Price": f"{h['current_price']:.2f}",
            "Chg%": f"{h['price_change_pct']:+.2f}",
            "Volume": f"{int(h['current_volume']):,}",
            f"{VOLUME_AVG_WINDOW}D Avg": f"{int(h['avg_volume']):,}",
            "Ratio": f"{h['ratio']:.2f}x",
        } for h in volume_hits]).sort_values("Ticker")
        print(f"\n--- Volume Alerts ({len(volume_hits)}) ---")
        _print_bordered_table(df)

    if low_hits:
        df = pd.DataFrame([{
            "Ticker": h["ticker"],
            "Low": f"{h['current_low']:.2f}",
            f"{LOW_DRAWDOWN_LOOKBACK}D High": f"{h['peak_price']:.2f}",
            "High Date": h["peak_date"],
            "Drawdown%": f"{-h['drawdown_pct']:.2f}",
        } for h in low_hits]).sort_values("Ticker")
        print(f"\n--- LOW-Price Alerts ({len(low_hits)}) ---")
        _print_bordered_table(df)

    if rsi_hits:
        df = pd.DataFrame([{
            "Ticker": h["ticker"],
            "Prev RSI": f"{h['prev_rsi']:.2f}",
            "Cur RSI": f"{h['current_rsi']:.2f}",
            "Drop%": f"{h['drop_pct']:.2f}",
        } for h in rsi_hits]).sort_values("Ticker")
        print(f"\n--- RSI Drop Alerts ({len(rsi_hits)}) ---")
        _print_bordered_table(df)

    print()


def fetch_ohlcv(ticker, as_of_date=None):
    """
    Downloads daily OHLCV history from Yahoo Finance, covering enough calendar days to
    guarantee at least LOW_DRAWDOWN_LOOKBACK trading rows. Shared by both the volume and
    LOW-price checks so each ticker only needs one network round-trip per run.

    When as_of_date is given, the result is truncated to rows on or before that date so the
    last row is guaranteed to be that date's bar (not a later one) regardless of Yahoo's
    exact bar-timestamp/timezone semantics.
    """
    try:
        if as_of_date:
            # Small buffer past the target date to comfortably capture its bar; the explicit
            # truncation below is what actually guarantees correctness, not this buffer.
            end_date = int((pd.Timestamp(as_of_date) + pd.Timedelta(days=3)).timestamp())
        else:
            end_date = int(time.time())

        start_date = end_date - (FETCH_DAYS_BACK * 24 * 60 * 60)

        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?period1={start_date}&period2={end_date}&interval=1d"
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}

        response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json()

        result = data.get('chart', {}).get('result', [])
        if not result:
            print(f"No data returned from Yahoo Finance for {ticker}")
            return None

        timestamps = result[0]['timestamp']
        quote = result[0]['indicators']['quote'][0]

        df = pd.DataFrame({
            'timestamp': timestamps,
            'open': quote['open'],
            'high': quote['high'],
            'low': quote['low'],
            'close': quote['close'],
            'volume': quote['volume']
        }).dropna()

        df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.strftime('%Y-%m-%d')

        if as_of_date:
            df = df[df['date'] <= as_of_date].reset_index(drop=True)
            if df.empty:
                print(f"No data on or before {as_of_date} for {ticker}")
                return None

        return df

    except Exception as e:
        print(f"Error fetching data for {ticker}: {e}")
        return None


def check_live_volume(ticker, df, ref_date=None):
    """
    Returns a dict of alert details if ref_date's volume exceeds VOLUME_THRESHOLD_MULTIPLIER x
    the trailing VOLUME_AVG_WINDOW-day average, else None. Only evaluates when the latest
    available row is from ref_date (defaults to today).
    """
    ref_date = ref_date or TODAY_STR
    try:
        if len(df) < VOLUME_AVG_WINDOW + 1:
            print(f"Not enough historical days to calculate volume baseline for {ticker}.")
            return None

        latest_row = df.iloc[-1]
        target_date_str = latest_row['date']

        if target_date_str != ref_date:
            print(f"Skipping volume check for {ticker}: latest data ({target_date_str}) is not from the target date ({ref_date}).")
            return None

        current_volume = latest_row['volume']
        current_price = latest_row['close']

        prev_price = df.iloc[-2]['close']
        price_change_pct = ((current_price - prev_price) / prev_price) * 100

        historical_df = df.iloc[:-1].tail(VOLUME_AVG_WINDOW)
        avg_volume = historical_df["volume"].mean()
        
        ratio = current_volume / avg_volume

        if current_volume > (avg_volume * VOLUME_THRESHOLD_MULTIPLIER):
            
            print(f"Volume alert triggered for {ticker} on {target_date_str} ({ratio:.2f}x)")
            return {
                "ticker": ticker,
                "date": target_date_str,
                "current_price": current_price,
                "price_change_pct": price_change_pct,
                "current_volume": current_volume,
                "avg_volume": avg_volume,
                "ratio": ratio,
            }

        print(f"{ticker} on {target_date_str}: Volume is normal ({current_volume:,.0f} vs Avg {avg_volume:,.0f}, {ratio:.2f}x))")
        return None

    except Exception as e:
        print(f"Error checking live volume for {ticker}: {e}")
        return None


def check_low_price_alert(ticker, df, state, ref_date=None):
    """
    Returns a dict of alert details if ref_date's low is down LOW_DRAWDOWN_PCT% or more from
    the highest high of the trailing LOW_DRAWDOWN_LOOKBACK bars, and this is either a new
    episode or a new, deeper low within an already-ongoing one, else None. Episode identity
    is keyed on the reference peak's date (not merely "still below threshold"), so a single
    continuous decline against the same peak only re-alerts when it sets a genuinely new low
    — matching the Pine script's FIX #30/#31/#32 behavior. State persists in STATE_FILE
    across daily runs (callers doing ad-hoc/historical checks should pass a throwaway state
    dict instead of the persisted one — see the `is_adhoc` handling in __main__).
    """
    ref_date = ref_date or TODAY_STR
    try:
        if len(df) < LOW_DRAWDOWN_LOOKBACK:
            print(f"Not enough historical days to calculate LOW baseline for {ticker}.")
            return None

        latest_row = df.iloc[-1]
        target_date_str = latest_row['date']

        if target_date_str != ref_date:
            print(f"Skipping LOW check for {ticker}: latest data ({target_date_str}) is not from the target date ({ref_date}).")
            return None

        window = df.tail(LOW_DRAWDOWN_LOOKBACK)
        peak_idx = window['high'].idxmax()
        peak_price = float(window.loc[peak_idx, 'high'])
        peak_date = str(window.loc[peak_idx, 'date'])

        current_low = float(latest_row['low'])
        drawdown_pct = (peak_price - current_low) / peak_price * 100
        is_deep_drawdown = drawdown_pct > LOW_DRAWDOWN_PCT

        ticker_state = state.get(ticker, {})
        prev_peak_time = ticker_state.get("peak_time")
        prev_episode_lowest = ticker_state.get("episode_lowest")

        is_same_episode = is_deep_drawdown and prev_peak_time is not None and peak_date == prev_peak_time
        is_new_episode = is_deep_drawdown and not is_same_episode
        should_alert = is_new_episode or (is_same_episode and current_low < prev_episode_lowest)

        if is_deep_drawdown:
            new_episode_lowest = current_low if is_new_episode else min(prev_episode_lowest, current_low)
            state[ticker] = {"peak_time": peak_date, "episode_lowest": new_episode_lowest}

        if should_alert:
            print(f"LOW alert triggered for {ticker} on {target_date_str} (drawdown {drawdown_pct:.2f}% from {peak_date} high {peak_price:.2f})")
            return {
                "ticker": ticker,
                "date": target_date_str,
                "current_low": current_low,
                "peak_price": peak_price,
                "peak_date": peak_date,
                "drawdown_pct": drawdown_pct,
            }

        print(f"{ticker} on {target_date_str}: no new LOW alert (drawdown {drawdown_pct:.2f}%, threshold {LOW_DRAWDOWN_PCT}%)")
        return None

    except Exception as e:
        print(f"Error checking LOW price for {ticker}: {e}")
        return None


def compute_rsi(close_series, period=RSI_PERIOD):
    """Wilder's RSI (matches TradingView's ta.rsi): exponential smoothing with alpha = 1/period."""
    delta = close_series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def check_rsi_alert(ticker, df, ref_date=None):
    """
    Returns a dict of alert details if ref_date's RSI(RSI_PERIOD) has fallen by more than
    RSI_DROP_PCT% versus the previous trading date's RSI, else None. Unlike the LOW check,
    this is a plain day-over-day comparison — no multi-day "episode" state to dedupe, since a
    single sharp RSI drop is itself the complete signal.
    """
    ref_date = ref_date or TODAY_STR
    try:
        if len(df) < RSI_PERIOD + 2:
            print(f"Not enough historical days to calculate RSI for {ticker}.")
            return None

        latest_row = df.iloc[-1]
        target_date_str = latest_row['date']

        if target_date_str != ref_date:
            print(f"Skipping RSI check for {ticker}: latest data ({target_date_str}) is not from the target date ({ref_date}).")
            return None

        rsi_series = compute_rsi(df['close'])
        current_rsi = rsi_series.iloc[-1]
        prev_rsi = rsi_series.iloc[-2]

        if pd.isna(current_rsi) or pd.isna(prev_rsi) or prev_rsi <= 0:
            print(f"Not enough RSI history yet for {ticker}.")
            return None

        drop_pct = (prev_rsi - current_rsi) / prev_rsi * 100

        if drop_pct > RSI_DROP_PCT:
            print(f"RSI alert triggered for {ticker} on {target_date_str} (RSI {prev_rsi:.2f} -> {current_rsi:.2f}, drop {drop_pct:.2f}%)")
            return {
                "ticker": ticker,
                "date": target_date_str,
                "prev_rsi": prev_rsi,
                "current_rsi": current_rsi,
                "drop_pct": drop_pct,
            }

        print(f"{ticker} on {target_date_str}: RSI drop normal ({drop_pct:.2f}%, threshold {RSI_DROP_PCT}%)")
        return None

    except Exception as e:
        print(f"Error checking RSI for {ticker}: {e}")
        return None


if __name__ == "__main__":
    args = parse_args()

    if not BOT_TOKEN or not CHANNEL_ID:
        print("Warning: Telegram bot token or chat ID not found. Ensure environment variables are set.")

    target_date = args.date or TODAY_STR
    tickers_to_check = [args.ticker] if args.ticker else TICKERS

    # Ad-hoc runs (a specific --ticker and/or a specific historical --date) never read or
    # write the shared episode-state file. That file also backs the live scheduled run, and
    # persisting a manual/backtest result into it could silently corrupt live episode
    # tracking (e.g. re-checking a 2022 date would overwrite today's real episode state).
    is_adhoc = bool(args.ticker) or bool(args.date)
    state = {} if is_adhoc else load_state()

    # Collect every alert from this run instead of sending one message per ticker/condition.
    volume_hits = []
    low_hits = []
    rsi_hits = []

    for t in tickers_to_check:
        df = fetch_ohlcv(t, as_of_date=args.date)
        if df is None:
            continue

        # Volume and LOW-price are independent signals — both are checked every run, and a
        # ticker can land in both lists at once (e.g. a deep drawdown accompanied by a volume
        # spike on the same bar is exactly the kind of day worth flagging twice, not once).
        low_hit = check_low_price_alert(t, df, state, ref_date=target_date)
        if low_hit:
            low_hits.append(low_hit)

        volume_hit = check_live_volume(t, df, ref_date=target_date)
        if volume_hit:
            volume_hits.append(volume_hit)

        # RSI is an independent momentum signal, not part of the Volume/LOW exclusivity —
        # it's checked (and can fire) regardless of whether either of those already did.
        rsi_hit = check_rsi_alert(t, df, ref_date=target_date)
        if rsi_hit:
            rsi_hits.append(rsi_hit)

        if len(tickers_to_check) > 1:
            time.sleep(REQUEST_DELAY_SEC)

    if not is_adhoc:
        save_state(state)

    print_console_report(volume_hits, low_hits, rsi_hits, ref_date=target_date)

    if not args.no_telegram and BOT_TOKEN and CHANNEL_ID:
        message = build_consolidated_message(volume_hits, low_hits, rsi_hits, ref_date=target_date)
        send_telegram_message(message)
