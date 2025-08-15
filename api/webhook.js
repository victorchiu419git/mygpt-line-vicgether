export const config = { runtime: 'edge' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '你是官方客服助理，繁中、精準、條列為主。';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 讓 OpenAI 最多等 18 秒，保證整體 < 25 秒
const OPENAI_TIMEOUT_MS = 18000;
// 保守避免 LINE 5000 字上限
const MAX_LINE_TEXT = 4800;

function truncateForLine(text, max = MAX_LINE_TEXT) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

async function askOpenAI(userText) {
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
        max_tokens: 256,               // 限制生成長度，降低延遲
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText }
        ]
      })
    });

    if (resp.status === 429) {
      // 額度不足/速率限制 → 回代碼給上層
      let code = '';
      try { code = (await resp.json())?.error?.code || ''; } catch {}
      return code === 'insufficient_quota' ? '__QUOTA__' : '__RATE__';
    }
    if (!resp.ok) {
      const t = await resp.text().catch(()=>'');
      throw new Error(`OpenAI API error: ${resp.status} ${t}`);
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || '（沒有產生回覆）';

  } catch (e) {
    if (e?.name === 'AbortError' || e === 'timeout') return '__TIMEOUT__';
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function replyToLine(replyToken, text) {
  const payload = {
    replyToken,
    messages: [{ type: 'text', text: truncateForLine(text) }]
  };
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
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await req.json().catch(() => ({}));

    // Verify/健康檢查：events 通常為空 → 立刻回 200
    if (Array.isArray(body?.events) && body.events.length === 0) {
      return new Response('OK', { status: 200 });
    }

    const events = body?.events || [];
    // 逐一處理訊息；每個事件都保證在 timeout 前結束
    await Promise.all(events.map(async (ev) => {
      try {
        if (ev.type === 'message' && ev.message?.type === 'text') {
          const q = (ev.message.text || '').trim();
          const ans = await askOpenAI(q);

          if (ans === '__TIMEOUT__') {
            await replyToLine(ev.replyToken, '系統稍忙，我再想一下，請稍後再試或改問更精準的問題～');
            return;
          }
          if (ans === '__QUOTA__') {
            await replyToLine(ev.replyToken, 'AI 服務額度不足或未開通付款，請稍後再試。');
            return;
          }
          if (ans === '__RATE__') {
            await replyToLine(ev.replyToken, '現在請求較多，請稍候幾秒再試。');
            return;
          }

          await replyToLine(ev.replyToken, ans);

        } else if (ev.type === 'message') {
          await replyToLine(ev.replyToken, '目前僅支援文字訊息喔。');
        } else if (ev.type === 'follow') {
          await replyToLine(ev.replyToken, '感謝加入！直接輸入您的問題，我會盡力協助。');
        } else if (ev.type === 'join') {
          await replyToLine(ev.replyToken, '大家好～我可以協助回答常見問題！');
        }
      } catch (e) {
        console.error('Event error:', e);
      }
    }));

    // ✅ 關鍵：不論如何，**一定**回 200
    return new Response('OK', { status: 200 });

  } catch (e) {
    console.error('Handler error:', e);
    return new Response('OK', { status: 200 });
  }
}
