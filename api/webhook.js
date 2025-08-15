export const config = { runtime: 'edge' };

// ===== Line config =====
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const MAX_LEN = 4800;
// 把回覆超時調長到 12 秒（避免偶發網路慢）
const REPLY_TIMEOUT_MS = 12000;

function cut(t, n = MAX_LEN) { return t && t.length > n ? t.slice(0, n) : (t || ''); }

// 回覆 LINE，並詳細紀錄狀態碼 / 回傳內文 / 逾時
async function replyToLine(replyToken, text, debug = {}) {
  if (!replyToken) { console.error('REPLY_SKIP: missing replyToken', debug); return; }
  if (!LINE_TOKEN) { console.error('REPLY_SKIP: missing LINE_CHANNEL_ACCESS_TOKEN', debug); return; }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), REPLY_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: cut(text) }] })
    });

    const body = await res.text().catch(() => '');
    if (!res.ok) {
      console.error('REPLY_FAIL', { status: res.status, body, debug });
    } else {
      console.log('REPLY_OK', { status: res.status, debug });
    }
  } catch (e) {
    // 這裡若是超時，平台有時候只回 'Error'，仍會記錄 REPLY_ERR
    console.error('REPLY_ERR', { error: e?.name || String(e), debug });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req) {
  try {
    // 健康檢查 / Verify
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('OK', { status: 200 });

    // 讀原始字串，壞 JSON 也不影響回 200
    const raw = await req.text().catch(() => '');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}

    const events = Array.isArray(body?.events) ? body.events : [];
    const ev = events[0];

    if (ev) {
      const mode = ev.mode || '(unknown)';
      const userId = ev.source?.userId || '(none)';
      console.log('EVENT_MODE', { mode, userIdTail: userId.slice(-6), hasToken: !!LINE_TOKEN });

      if (ev.type === 'message' && ev.message?.type === 'text') {
        const replyToken = ev.replyToken;
        const debug = { mode, userIdTail: userId.slice(-6) };
        // 同步回覆一句（≤12s），完成後立刻回 200
        await replyToLine(replyToken, '已收到，我正在處理，稍後提供完整答案。', debug);
      }
    }

    // ✅ 一律回 200，避免 LINE 重送
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('WEBHOOK_ERR', e?.message || e);
    return new Response('OK', { status: 200 });
  }
}
