// api/webhook.js — Node Serverless（單則快速 AI 回覆）
// 需要環境變數：OPENAI_API_KEY、LINE_CHANNEL_ACCESS_TOKEN（Production）

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  '你是「亦啟科技 VicGether / POWAH」的 LINE 客服助理。請用繁體中文、精準短句與條列回覆；先給結論，再補 2–4 點重點。';

const MAX_LEN = 4800;
const OPENAI_TIMEOUT_MS = 5000; // 5s 取 AI，保證整體 < 10s
const REPLY_TIMEOUT_MS  = 4000; // 4s 回 LINE

const cut = (t, n = MAX_LEN) => (t && t.length > n ? t.slice(0, n) : (t || ''));

// 讀取原始 POST body（Node）
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

// 取 AI（5s 硬性逾時 + 短答）
async function askOpenAI(userText) {
  if (!OPENAI_KEY) return '（AI 金鑰未設定，請稍後再試或轉人工）';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), OPENAI_TIMEOUT_MS);

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.3,
        max_tokens: 230, // 短答，降低延遲
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText }
        ]
      })
    });

    if (r.status === 429) {
      let code = '';
      try { code = (await r.json())?.error?.code || ''; } catch {}
      return code === 'insufficient_quota'
        ? '（AI 服務額度不足或未完成付款設定，請稍後再試或改由人工協助）'
        : '（目前請求較多，請稍候幾秒再試）';
    }

    if (!r.ok) {
      const t = await r.text().catch(()=> '');
      console.error('OPENAI_FAIL', r.status, t.slice(0,200));
      return `（AI 服務暫時無法使用：${r.status}）`;
    }

    const data = await r.json();
    const txt = data?.choices?.[0]?.message?.content?.trim();
    return txt || '（沒有產生可用回覆）';
  } catch (e) {
    console.error('OPENAI_ERR', e?.name || String(e));
    if (e?.name === 'AbortError') return '（系統稍忙，我再想一下，請稍後再試或改問更精準的問題）';
    return '（系統暫時發生問題，請稍後再試）';
  } finally {
    clearTimeout(timer);
  }
}

// 回覆到 LINE（4s 硬性逾時）
async function replyToLine(replyToken, text, debug = {}) {
  if (!replyToken) { console.error('REPLY_SKIP missing replyToken', debug); return; }
  if (!LINE_TOKEN) { console.error('REPLY_SKIP missing LINE_TOKEN', debug); return; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), REPLY_TIMEOUT_MS);

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
    const body = await r.text().catch(()=>'');
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
    if (req.method !== 'POST') return res.status(200).send('OK');

    const raw = await readRaw(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}

    const ev = Array.isArray(body?.events) ? body.events[0] : null;
    if (ev) {
      const mode = ev.mode || '(unknown)';
      const userId = ev.source?.userId || '(none)';
      console.log('EVENT_MODE', { mode, userIdTail: userId.slice(-6), hasKey: !!OPENAI_KEY, hasLine: !!LINE_TOKEN });

      if (ev.type === 'message' && ev.message?.type === 'text') {
        const replyToken = ev.replyToken;
        const userText   = (ev.message.text || '').trim();
        const ans        = await askOpenAI(userText);
        await replyToLine(replyToken, ans, { mode, userIdTail: userId.slice(-6) });
      } else if (ev.type === 'message') {
        await replyToLine(ev.replyToken, '目前僅支援文字訊息喔。', { mode, userIdTail: userId.slice(-6) });
      } else if (ev.type === 'follow') {
        await replyToLine(ev.replyToken, '感謝加入！直接輸入您的問題，我會盡力協助。', { mode, userIdTail: userId.slice(-6) });
      }
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error('WEBHOOK_ERR', e?.message || e);
    return res.status(200).send('OK');
  }
}
