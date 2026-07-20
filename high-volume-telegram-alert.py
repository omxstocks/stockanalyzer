import os
import time
import requests
import pandas as pd

# Configuration
TICKERS = [
    "ABB.ST", "AZN.ST", "INVE-A.ST", "INVE-B.ST", "LUG.ST", "LUMI.ST", "NDA-SE.ST", "SAAB-B.ST",
    "SEB-A.ST", "SHB-B.ST", "SWED-A.ST", "VOLV-B.ST", "RELIANCE.NS", "TCS.NS", "LT.NS", "ICICIBANK.NS",
    "HDFCBANK.NS", "NIFTYBEES.NS", "GOLDBEES.NS", "AAPL", "MSFT", "NVDA", "IBN", "ALFA.ST", "ADDT-B.ST",
    "ASSA-B.ST", "ATCO-A.ST", "BOL.ST", "EPI-A.ST", "EQT.ST", "ERIC-B.ST", "ESSITY-B.ST", "EVO.ST", "SHB-A.ST",
    "INDU-C.ST", "LIFCO-B.ST", "SAND.ST", "SKA-B.ST", "SKF-B.ST", "TEL2-B.ST", "TELIA.ST"
]
THRESHOLD_MULTIPLIER = 2.3
TODAY_STR = pd.Timestamp.today().strftime('%Y-%m-%d')

# Retrieve secrets from environment variables
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHANNEL_ID = os.getenv("TELEGRAM_CHAT_ID")

def send_telegram_summary(total_alerts):
    """Sends a final summary of alerts generated to the Telegram channel."""
    if total_alerts == 0:
        summary_msg = f"📊 *Volume Alerts Summary for {TODAY_STR}*\nNo volume alerts triggered today.\nℹ️ Source: Yahoo Finance"
    else:
        summary_msg = f"📊 *Volume Alerts Summary for {TODAY_STR}*\nTotal alerts triggered today: *{total_alerts}*\nℹ️ Source: Yahoo Finance"
        
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": CHANNEL_ID, "text": summary_msg, "parse_mode": "Markdown"}
    try:
        requests.post(url, json=payload)
    except Exception as e:
        print(f"Error sending summary Telegram message: {e}")

def send_telegram_alert(ticker, date_str, current_price, price_change_pct, current_volume, avg_volume, ratio):
    """Sends the formatted alert to the Telegram channel."""
    # Using a red circle for negative values as per preference
    trend_indicator = "🔴" if price_change_pct < 0 else "🟢"
    
    # Format the ticker as a markdown hyperlink pointing to Yahoo Finance
    ticker_link = f"(https://finance.yahoo.com/chart/{ticker})"
    
    alert_msg = (
        f"🚨 *Volume Alert: {ticker_link}*\n"
        f"📅 Date: {date_str}\n"
        f"💵 Price: {current_price:.2f} {trend_indicator} ({price_change_pct:+.2f}%)\n"
        f"📊 Current Vol: {int(current_volume):,}\n"
        f"📉 21D Avg Vol: {int(avg_volume):,}\n"
        f"⚡ Multiplier: *{ratio:.2f}x* (Threshold: {THRESHOLD_MULTIPLIER}x)\n"
        #TODO : ENTRY, TARGET, SL
        #f"ℹ️ Source: Yahoo Finance"
    )
    
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    
    # Ensuring parse_mode is set to "Markdown" so the URL renders correctly
    payload = {"chat_id": CHANNEL_ID, "text": alert_msg, "parse_mode": "Markdown"}
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
    except Exception as e:
        print(f"Error sending Telegram message for {ticker}: {e}")

def check_live_volume(ticker):
    """
    Production Function: Downloads real-time / historical data directly from Yahoo Finance.
    Automatically identifies the most recent trading day and compares it against 
    the preceding 21 days.
    """
    try:
        # Fetch data strictly from Yahoo Finance API directly
        end_date = int(time.time())
        start_date = end_date - (40 * 24 * 60 * 60) # 40 days back to ensure 22 trading days
        
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?period1={start_date}&period2={end_date}&interval=1d"
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()
        
        result = data.get('chart', {}).get('result', [])
        if not result:
            print(f"No data returned from Yahoo Finance for {ticker}")
            return False
            
        timestamps = result[0]['timestamp']
        quote = result[0]['indicators']['quote'][0]
        
        df = pd.DataFrame({
            'timestamp': timestamps,
            'close': quote['close'],
            'volume': quote['volume']
        }).dropna()

        if len(df) < 22:
            print(f"Not enough historical days to calculate baseline for {ticker}.")
            return False

        df['date'] = pd.to_datetime(df['timestamp'], unit='s').dt.strftime('%Y-%m-%d')

        latest_row = df.iloc[-1]
        target_date_str = latest_row['date']
        
        # Ensure we only evaluate and send alerts for the current date
        if target_date_str != TODAY_STR:
            print(f"Skipping {ticker}: Latest data ({target_date_str}) is not from today ({TODAY_STR}).")
            return False

        current_volume = latest_row['volume']
        current_price = latest_row['close']
        
        # Calculate daily percentage change to display red/green trends
        prev_price = df.iloc[-2]['close']
        price_change_pct = ((current_price - prev_price) / prev_price) * 100

        # Isolate the previous 21 days, excluding the target/latest day
        historical_df = df.iloc[:-1].tail(21)
        avg_volume_21 = historical_df["volume"].mean()

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
    # Ensure tokens exist to avoid running fruitless requests
    if not BOT_TOKEN or not CHANNEL_ID:
        print("Warning: Telegram bot token or chat ID not found. Ensure environment variables are set.")
    
    # Track the number of alerts sent
    alerts_sent_count = 0
    
    # Live execution sample run
    for t in TICKERS:
        # Script automatically checks the latest available day!
        if check_live_volume(t):
            alerts_sent_count += 1
            
    # Send the final summary count message
    if BOT_TOKEN and CHANNEL_ID:
        send_telegram_summary(alerts_sent_count)