// api/webhook.js  — Node runtime（已用 vercel.json 鎖定為 nodejs）

// 你的 LINE 長期 Token（放在 Vercel 環境變數 Production）
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 安全截斷，避免超過 LINE 單則字數上限
const MAX_LEN = 4800;
const cut = (t, n = MAX_LEN) => (t && t.length > n ? t.slice(0, n) : (t || ''));

// 讀 POST 原始 body（Node）
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

// 呼叫 LINE Reply API（12 秒逾時）
async function replyToLine(replyToken, text, debug = {}) {
  if (!replyToken) { console.error('REPLY_SKIP missing replyToken', debug); return; }
  if (!LINE_TOKEN) { console.error('REPLY_SKIP missing LINE_TOKEN', debug); return; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), 12000);

  try {
    const r = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: 'text', text: cut(text) }]
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
    // GET / 檢查用
    if (req.method !== 'POST') return res.status(200).send('OK');

    // 讀取事件
    const raw = await readRaw(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const ev = Array.isArray(body?.events) ? body.events[0] : null;

    if (ev) {
      const mode = ev.mode || '(unknown)';
      const userId = ev.source?.userId || '(none)';
      console.log('EVENT_MODE', { mode, userIdTail: userId.slice(-6), hasToken: !!LINE_TOKEN });

      // 只處理「文字訊息」
      if (ev.type === 'message' && ev.message?.type === 'text') {
        const replyToken = ev.replyToken;
        const debug = { mode, userIdTail: userId.slice(-6) };

        // 回一句固定話（你可改成 echo 或其他）
        await replyToLine(replyToken, '已收到，我正在處理。', debug);
      }
    }

    // ✅ 總是回 200，避免 LINE 重送
    return res.status(200).send('OK');
  } catch (e) {
    console.error('WEBHOOK_ERR', e?.message || e);
    return res.status(200).send('OK');
  }
}
