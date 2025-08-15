export const config = { runtime: 'edge' };

// === 可調參數 ===
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  '你是官方 LINE 客服助理，請用繁體中文，條列、精準、短句。不確定時請先釐清。';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// **關鍵**：將 OpenAI 等待時間壓到 9 秒，留足夠時間給 LINE 回覆與收尾
const OPENAI_TIMEOUT_MS = 9000;
const MAX_TOKENS = 200;
const MAX_LINE_LEN = 4800;

// 截斷，避免超過 LINE 字數限制
function cut(text, n = MAX_LINE_LEN) {
  if (!text) return '';
  return text.length > n ? text.slice(0, n) : text;
}

// 呼叫 OpenAI，9 秒逾時
async function askOpenAI(content) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), OPENAI_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.3,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: content }
        ]
      })
    });

    if (resp.status === 429) {
      // 額度不足或速率限制（回代碼給上層）
      let code = '';
      try { code = (await resp.json())?.error?.code || ''; } catch {}
      return code === 'insufficient_quota' ? '__QUOTA__' : '__RATE__';
    }
    if (!resp.ok) {
      const t = await resp.text().catch(()=> '');
      throw new Error(`OpenAI API error: ${resp.status} ${t}`);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || '（沒有產生回覆）';
  } catch (e) {
    if (e?.name === 'AbortError' || e === 'timeout') return '__TIMEOUT__';
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 回覆 LINE（replyToken 只能用一次）
async function replyToLine(replyToken, text) {
  const payload = { replyToken, messages: [{ type: 'text', text: cut(text) }] };
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    throw new Error(`LINE reply error: ${r.status} ${t}`);
  }
}

export default async function handler(req) {
  try {
    // 健康檢查 / Verify
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await req.json().catch(() => ({}));

    // Verify 送空 events → 立刻回 200
    if (Array.isArray(body?.events) && body.events.length === 0) {
      return new Response('OK', { status: 200 });
    }

    const ev = Array.isArray(body?.events) ? body.events[0] : null; // 只處理第一個事件，降低耗時
    if (!ev) return new Response('OK', { status: 200 });

    try {
      if (ev.type === 'message' && ev.message?.type === 'text') {
        const q = (ev.message.text || '').trim();
        const ans = await askOpenAI(q);

        if (ans === '__TIMEOUT__') {
          await replyToLine(ev.replyToken, '系統目前較忙，請稍後再試或改問更精準的問題～');
        } else if (ans === '__QUOTA__') {
          await replyToLine(ev.replyToken, 'AI 服務額度不足或尚未開通付款，稍後再試或轉人工協助。');
        } else if (ans === '__RATE__') {
          await replyToLine(ev.replyToken, '目前請求較多，請稍候幾秒再試。');
        } else {
          await replyToLine(ev.replyToken, ans);
        }

      } else if (ev.type === 'message') {
        await replyToLine(ev.replyToken, '目前僅支援文字訊息喔。');

      } else if (ev.type === 'follow') {
        await replyToLine(ev.replyToken, '感謝加入！直接輸入您的問題，我會盡力協助。');

      } else if (ev.type === 'join') {
        await replyToLine(ev.replyToken, '大家好～我可以協助回答常見問題！');
      }
    } catch (e) {
      console.error('Event error:', e);
      // 即使內部失敗，也回使用者一段話，避免沉默
      try { await replyToLine(ev.replyToken, '抱歉，系統暫時忙碌，請稍後再試。'); } catch (_) {}
    }

    // **關鍵**：不論如何都在 25 秒內回 200
    return new Response('OK', { status: 200 });

  } catch (e) {
    console.error('Handler error:', e);
    // 即使發生錯誤也回 200，避免 LINE 重送造成雪崩
    return new Response('OK', { status: 200 });
  }
}
