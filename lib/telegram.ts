// Internal Telegram notifications for the Mthryve OS team group.
//
// Deliberately best-effort and defensive: a missing/revoked token or a Telegram
// outage must NEVER crash a page, an approval, or any other request. Every
// failure path returns { ok: false } and swallows the error — callers await
// this purely for the side effect and ignore the result on the hot path.
//
// Credentials live only in Vercel env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID),
// never NEXT_PUBLIC_* — so this module is server-only by construction.

export async function sendTelegram(text: string): Promise<{ ok: boolean }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // No credentials configured → quietly no-op. Not an error worth logging.
  if (!token || !chatId) return { ok: false };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    return { ok: res.ok };
  } catch (err) {
    // Revoked token, DNS/network failure, Telegram down — log and swallow.
    console.error("[telegram] sendMessage failed", err);
    return { ok: false };
  }
}

// Escapes the five characters Telegram's HTML parse_mode treats as markup, so
// user-supplied titles/summaries can't break the message or inject tags.
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
