import os
import time
import requests
import pandas as pd
from datetime import datetime

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

def send_telegram_alert(ticker, date_str, current_price, price_change_pct, current_volume, avg_volume, ratio):
    """Sends the formatted alert to the Telegram channel."""
    
    # Using a Red Emoji to clearly indicate negative values in Telegram (which lacks font-color tags)
    trend_emoji = "🔴" if price_change_pct < 0 else "🟢"
    
    alert_msg = (
        f"🚨 *Volume Alert: {ticker}*\n"
        f"📅 Date: {date_str}\n"
        f"💵 Price: {current_price:.2f} {trend_emoji} ({price_change_pct:+.2f}%)\n"
        f"📊 Current Vol: {int(current_volume):,}\n"
        f"📉 21D Avg Vol: {int(avg_volume):,}\n"
        f"⚡ Multiplier: *{ratio:.2f}x* (Threshold: {THRESHOLD_MULTIPLIER}x)\n"
        f"ℹ️ Source: Yahoo Finance"
    )
    
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": CHANNEL_ID, "text": alert_msg, "parse_mode": "Markdown"}
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
    except Exception as e:
        print(f"Error sending Telegram message for {ticker}: {e}")

def check_live_volume(ticker):
    """
    Downloads historical data using the explicit Yahoo Finance Chart API.
    Identifies the most recent trading day and compares it against the preceding 21 days.
    """
    try:
        # Calculate timestamps (Fetch ~40 days to guarantee at least 22 valid trading days)
        end_date = int(time.time())
        start_date = end_date - (40 * 24 * 60 * 60)
        
        # Using the explicitly preferred Yahoo Finance API Endpoint
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?period1={start_date}&period2={end_date}&interval=1d"
        
        # Yahoo Finance requires a User-Agent to prevent 403 Forbidden errors
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()
        
        result = data.get('chart', {}).get('result', [])
        if not result:
            print(f"No data returned from Yahoo Finance for {ticker}")
            return False
            
        # Extract raw data points
        timestamps = result[0]['timestamp']
        quote = result[0]['indicators']['quote'][0]
        
        df = pd.DataFrame({
            'timestamp': timestamps,
            'close': quote['close'],
            'volume': quote['volume']
        })
        
        # Clean up data (remove days where volume or close might be null due to market holidays)
        df = df.dropna()
        
        if len(df) < 22: # We need 1 current day + 21 historical days
            print(f"Not enough historical trading days for {ticker} to calculate baseline.")
            return False
            
        df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.strftime('%Y-%m-%d')
        
        # Latest day data
        latest_row = df.iloc[-1]
        target_date_str = latest_row['date']
        current_volume = latest_row['volume']
        current_price = latest_row['close']
        
        # Calculate daily price change percentage to show negatives clearly
        prev_price = df.iloc[-2]['close']
        price_change_pct = ((current_price - prev_price) / prev_price) * 100

        # Isolate the previous 21 days
        historical_df = df.iloc[:-1].tail(21)
        avg_volume_21 = historical_df["volume"].mean()

        # Evaluate against our criteria
        if current_volume > (avg_volume_21 * THRESHOLD_MULTIPLIER):
            ratio = current_volume / avg_volume_21
            print(f"Alert triggered for {ticker} on {target_date_str} ({ratio:.2f}x)")
            send_telegram_alert(ticker, target_date_str, current_price, price_change_pct, current_volume, avg_volume_21, ratio)
            return True
            
        print(f"{ticker} on {target_date_str}: Volume is normal ({current_volume:,} vs Avg {avg_volume_21:,.0f})")
        return False

    except Exception as e:
        print(f"Error checking live volume for {ticker}: {e}")
        return False

if __name__ == "__main__":
    if not BOT_TOKEN or not CHANNEL_ID:
        print("Warning: Telegram bot token or chat ID not found. Ensure environment variables are set.")
    
    for t in TICKERS:
        check_live_volume(t)