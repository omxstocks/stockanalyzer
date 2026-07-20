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
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHANNEL_ID = os.getenv("TELEGRAM_CHAT_ID")

def send_telegram_alert(ticker, date_str, current_price, current_volume, avg_volume, ratio):
    """Sends the formatted alert to the Telegram channel."""
    # Applying clear data points to the alert message as per your preferences
    alert_msg = (
        f"🚨 *Volume Alert: {ticker}*\n"
        f"📅 Date: {date_str}\n"
        f"💰 Price: {current_price:.2f}\n"
        f"📊 Current Vol: {int(current_volume):,}\n"
        f"📉 21D Avg Vol: {int(avg_volume):,}\n"
        f"⚡ Multiplier: *{ratio:.2f}x* (Threshold: {THRESHOLD_MULTIPLIER}x)"
    )
    
    # FIX: Corrected Telegram API Endpoint URL structure
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": CHANNEL_ID, "text": alert_msg, "parse_mode": "Markdown"}
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
    except Exception as e:
        print(f"Error sending Telegram message for {ticker}: {e}")

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

def check_live_volume(ticker):
    """
    Production Function: Downloads real-time / historical data from Yahoo Finance.
    Automatically identifies the most recent trading day and compares it against 
    the preceding 21 days.
    """
    try:
        # Fetch data strictly from Yahoo Finance
        stock = yf.Ticker(ticker)
        # Pull 35 days of history to guarantee enough historical data points
        df = stock.history(period="35d")

        if df.empty:
            print(f"No data returned from Yahoo Finance for {ticker}")
            return False

        # FIX: Dynamically get the latest available date instead of a hardcoded string
        target_date = df.index[-1]
        target_date_str = target_date.strftime('%Y-%m-%d')

        # Isolate the previous 21 days, excluding the target/latest day
        historical_df = df.iloc[:-1].tail(21)

        if len(historical_df) < 21:
            print(f"Not enough historical days before {target_date_str} to calculate baseline.")
            return False

        avg_volume_21 = historical_df["Volume"].mean()
        current_volume = df.iloc[-1]["Volume"]
        current_price = df.iloc[-1]["Close"]

        return evaluate_volume_data(ticker, target_date_str, current_price, current_volume, avg_volume_21)

    except Exception as e:
        print(f"Error checking live volume for {ticker}: {e}")
        return False

if __name__ == "__main__":
    # Ensure tokens exist to avoid running fruitless requests
    if not BOT_TOKEN or not CHANNEL_ID:
        print("Warning: Telegram bot token or chat ID not found. Ensure environment variables are set.")
    
    # Live execution sample run
    for t in TICKERS:
        # We no longer pass a hardcoded date. The script will automatically check the latest available day!
        check_live_volume(t)
