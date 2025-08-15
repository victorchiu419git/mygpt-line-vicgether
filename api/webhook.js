import { waitUntil } from '@vercel/functions';

export const config = { runtime: 'edge' };

// ===== Line config =====
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const MAX_LEN = 4800;
const REPLY_TIMEOUT_MS = 6000; // 回覆最長等 6 秒（仍遠小於 25s）

function cut(t, n = MAX_LEN) { return t && t.length > n ? t.slice(0, n) : (t || ''); }

// 只做回覆；詳細紀錄狀態碼與回傳內文
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

    // 讀原始字串，避免解析阻塞；壞 JSON 也不影響回 200
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

        // ✅ 用 Vercel 官方 waitUntil，在回 200 之後背景執行回覆
        waitUntil(replyToLine(replyToken, '已收到，我正在處理，稍後提供完整答案。', debug));
      }
    }

    // ✅ 立刻回 200，絕不等待外部呼叫
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('WEBHOOK_ERR', e?.message || e);
    return new Response('OK', { status: 200 });
  }
}
