import os
import requests
import pandas as pd
import yfinance as yf

# Configuration
TICKERS = [
"ABB.ST", "AZN.ST", "INVE-A.ST", "INVE-B.ST", "LUG.ST", "LUMI.ST", "NDA-SE.ST", "SAAB-B.ST",
"SEB-A.ST", "SHB-B.ST", "SWED-A.ST", "VOLV-B.ST", "RELIANCE.NS", "TCS.NS", "LT.NS", "ICICIBANK.NS",
"HDFCBANK.NS", "NIFTYBEES.NS", "GOLDBEES.NS", "AAPL", "MSFT", "NVDA", "IBN", "ALFA.ST", "ADDT-B.ST",
"ASSA-B.ST", "ATCO-A.ST", "BOL.ST", "EPI-A.ST", "EQT.ST", "ERIC-B.ST", "ESSITY-B.ST", "EVO.ST", "SHB-A.ST",
"INDU-C.ST", "LIFCO-B.ST", "SAND.ST", "SKA-B.ST", "SKF-B.ST", "TEL2-B.ST", "TELIA.ST"
]
THRESHOLD_MULTIPLIER = 2.3

# Retrieve secrets from environment variables
#BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "7884686758:AAEQCdzx4aPdtveJzjAC-XOLVBQKyRCM-Rk")
#CHANNEL_ID = os.environ.get("TELEGRAM_CHAT_ID", "@NrkStockMarketBot")

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHANNEL_ID = os.getenv("TELEGRAM_CHAT_ID")

def send_telegram_alert(ticker, date_str, current_price, current_volume, avg_volume, ratio):
    """Sends the formatted alert to the Telegram channel."""
    alert_msg = (
        f"*Volume Alert: {ticker}*\n"
        f"Date: {date_str}\n"
        f"Price: {current_price:.2f} SEK\n"
        f"Current Vol: {int(current_volume):,}\n"
        f"21D Avg Vol: {int(avg_volume):,}\n"
        f"Multiplier: *{ratio:.2f}x* (Threshold: {THRESHOLD_MULTIPLIER}x)"
    )
    url = f"https://telegram.org{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": CHANNEL_ID, "text": alert_msg, "parse_mode": "Markdown"}
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
    except Exception as e:
        print(f"Error sending Telegram message: {e}")


def evaluate_volume_data(ticker, date_str, current_price, current_volume, avg_volume):
    """
    Core engine that handles evaluation criteria logic.
    Returns True if an alert is sent, False otherwise.
    """
    if pd.isna(current_volume) or pd.isna(avg_volume) or avg_volume == 0:
        print(f"Invalid volume data for {ticker} on {date_str}")
        return False

    if current_volume > (avg_volume * THRESHOLD_MULTIPLIER):
        ratio = current_volume / avg_volume
        print(f"Alert triggered for {ticker} on {date_str} ({ratio:.2f}x)")
        send_telegram_alert(ticker, date_str, current_price, current_volume, avg_volume, ratio)
        return True
        
    print(f"{ticker} on {date_str}: Volume is normal ({current_volume:,} vs Avg {avg_volume:,.0f})")
    return False


def check_live_volume(ticker, target_date):
    """
    Production Function: Downloads real-time / historical data from Yahoo Finance.
    Filters data for the specific target date and calculates the 21-day average.
    """
    try:
        stock = yf.Ticker(ticker)
        # Pull 35 days of history to guarantee enough historical data points
        df = stock.history(period="35d")

        if df.empty:
            print(f"No data returned from Yahoo Finance for {ticker}")
            return False

        # Ensure index is matching text format YYYY-MM-DD
        df.index = df.index.strftime('%Y-%m-%d')

        if target_date not in df.index:
            print(f"Target date {target_date} not found in live data for {ticker}")
            return False

        # Isolate historical data up to (but excluding) the target date
        target_idx = df.index.get_loc(target_date)
        historical_df = df.iloc[:target_idx].tail(21)

        if len(historical_df) < 21:
            print(f"Not enough historical days before {target_date} to calculate baseline.")
            return False

        avg_volume_21 = historical_df["Volume"].mean()
        current_volume = df.loc[target_date, "Volume"]
        current_price = df.loc[target_date, "Close"]

        return evaluate_volume_data(ticker, target_date, current_price, current_volume, avg_volume_21)

    except Exception as e:
        print(f"Error checking live volume for {ticker}: {e}")
        return False


if __name__ == "__main__":
    # Live execution sample run
    for t in TICKERS:
        # Example target date (Change to current date string dynamically if needed)
        check_live_volume(t, "2026-07-17")
