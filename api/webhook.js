export const config = { runtime: 'edge' };

// 用最短的 2 秒超時回覆 LINE（避免任何等待過久）
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const MAX_LEN = 4800;

function cut(t, n = MAX_LEN) { return t && t.length > n ? t.slice(0, n) : (t || ''); }

async function replyToLineFast(replyToken, text) {
  if (!replyToken || !LINE_TOKEN) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), 2000); // 2s 上限

  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: 'text', text: cut(text) }]
      })
    });
  } catch (e) {
    // 不讓錯誤影響 webhook 回 200
    console.log('reply error/timeout:', e?.name || e);
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req) {
  try {
    // 健康檢查 / Verify
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('OK', { status: 200 });

    // 讀原始字串，比 json() 更保險
    const raw = await req.text().catch(() => '');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}

    const events = Array.isArray(body?.events) ? body.events : [];
    const ev = events[0];

    if (ev && ev.type === 'message' && ev.message?.type === 'text') {
      // 立即回覆一句固定話（只 await 這個、最快 2s 就會結束）
      await replyToLineFast(ev.replyToken, '已收到，我正在處理，稍後提供完整答案。');
    }

    // ✅ 關鍵：不做任何其它外部呼叫，**立刻回 200**
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.log('webhook fatal:', e?.message || e);
    return new Response('OK', { status: 200 });
  }
}
