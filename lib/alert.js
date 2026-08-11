// Shared alerting for the cron scripts (detect-deposits, sweep-deposits): a plain Telegram Bot
// API call, no dependency needed. Never throws — a failed alert shouldn't crash the script that's
// trying to report a problem, or mask the original error; it just falls back to a console.error
// so it's at least visible in Render's own logs.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("[ALERT] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured — alert not sent. Message was:", message);
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
    if (!response.ok) {
      console.error("[ALERT] Telegram API returned", response.status, await response.text());
    }
  } catch (error) {
    console.error("[ALERT] Failed to send Telegram alert:", error.message);
  }
}
