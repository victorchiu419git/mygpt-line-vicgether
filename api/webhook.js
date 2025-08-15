export const config = { runtime: 'edge' };

// ===== 參數 =====
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  '你是官方 LINE 客服助理，請用繁體中文，條列、精準、短句。不確定時先釐清。';

const OPENAI_TIMEOUT_MS = 8000; // 最多等 8 秒，保證整體 < 25 秒
const MAX_LINE_LEN = 4800;

// ===== 工具：截斷避免超長 =====
function cut(text, n = MAX_LINE_LEN) {
  if (!text) return '';
  return text.length > n ? text.slice(0, n) : text;
}

// ===== 呼叫 OpenAI（8 秒超時 + 短回覆）=====
async function askOpenAI(userText) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), OPENAI_TIMEOUT_MS);

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.3,
        max_tokens: 220, // 短答，降低延遲
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText }
        ]
      })
    });

    if (resp.status === 429) {
      // 額度或速率
      let code = '';
      try { code = (await resp.json())?.error?.code || ''; } catch {}
      return code === 'insufficient_quota'
        ? '（AI 服務額度不足或未開通付款，請稍後再試或轉人工協助）'
        : '（目前請求較多，請稍候幾秒再試）';
    }

    if (!resp.ok) {
      const t = await resp.text().catch(()=>'');
      return `（AI 服務暫時無法使用：${resp.status}）`;
    }

    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || '（沒有產生回覆）';

  } catch (e) {
    if (e?.name === 'AbortError' || e === 'timeout') {
      return '（系統稍忙，我再想一下，請稍後再試或改問更精準的問題）';
    }
    return '（系統暫時發生問題，請稍後再試）';
  } finally {
    clearTimeout(timer);
  }
}

// ===== 回覆 LINE（reply API）=====
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
  // 不中斷 webhook：即使失敗只記 log
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    console.error('LINE reply error:', r.status, t);
  }
}

// ===== 入口 =====
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

    const ev = Array.isArray(body?.events) ? body.events[0] : null;
    if (!ev) return new Response('OK', { status: 200 });

    if (ev.type === 'message' && ev.message?.type === 'text') {
      const replyToken = ev.replyToken;
      const userText = (ev.message.text || '').trim();

      // 先問 AI（最多 8 秒），再用 reply 回一則
      const ans = await askOpenAI(userText);
      await replyToLine(replyToken, ans);

      // 確保結尾回 200，避免重送
      return new Response('OK', { status: 200 });
    }

    // 其他訊息型別：回簡短提示
    if (ev.type === 'message') {
      await replyToLine(ev.replyToken, '目前僅支援文字訊息喔。');
    } else if (ev.type === 'follow') {
      await replyToLine(ev.replyToken, '感謝加入！直接輸入您的問題，我會盡力協助。');
    } else if (ev.type === 'join') {
      await replyToLine(ev.replyToken, '大家好～我可以協助回答常見問題！');
    }

    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('webhook error:', e);
    // 即使錯誤仍回 200，避免重送
    return new Response('OK', { status: 200 });
  }
}
