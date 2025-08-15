export const config = { runtime: 'nodejs18.x', regions: ['hnd1'] }; // Tokyo

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const MAX_LEN = 4800;
const REPLY_TIMEOUT_MS = 12000;

function cut(t, n = MAX_LEN) { return t && t.length > n ? t.slice(0, n) : (t || ''); }

// 讀取原始請求內容（Node 版）
function readRaw(req) {
  return new Promise((resolve) => {
    try {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
      req.on('error', () => resolve(''));
    } catch {
      resolve('');
    }
  });
}

async function replyToLine(replyToken, text, debug = {}) {
  if (!replyToken) { console.error('REPLY_SKIP: missing replyToken', debug); return; }
  if (!LINE_TOKEN) { console.error('REPLY_SKIP: missing LINE_CHANNEL_ACCESS_TOKEN', debug); return; }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), REPLY_TIMEOUT_MS);

  try {
    const r = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: 'text', text: cut('已收到，我正在處理，稍後提供完整答案。') }]
      })
    });
    const body = await r.text().catch(() => '');
    if (!r.ok) console.error('REPLY_FAIL', { status: r.status, body, debug });
    else console.log('REPLY_OK', { status: r.status, debug });
  } catch (e) {
    console.error('REPLY_ERR', { error: e?.name || String(e), debug });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return res.status(200).send('OK');

    // 只接受 POST，但也回 200 避免 LINE 重送雪崩
    if (req.method !== 'POST') return res.status(200).send('OK');

    const raw = await readRaw(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}

    const ev = Array.isArray(body?.events) ? body.events[0] : null;
    if (ev) {
      const mode = ev.mode || '(unknown)';
      const userId = ev.source?.userId || '(none)';
      console.log('EVENT_MODE', { mode, userIdTail: userId.slice(-6), hasToken: !!LINE_TOKEN });

      if (ev.type === 'message' && ev.message?.type === 'text') {
        const replyToken = ev.replyToken;
        const debug = { mode, userIdTail: userId.slice(-6) };
        await replyToLine(replyToken, '已收到，我正在處理，稍後提供完整答案。', debug);
      }
    }

    // ✅ 一律回 200
    return res.status(200).send('OK');
  } catch (e) {
    console.error('WEBHOOK_ERR', e?.message || e);
    return res.status(200).send('OK');
  }
}
