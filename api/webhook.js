export const config = { runtime: 'edge' };

// ===== 參數 =====
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  '你是官方 LINE 客服助理，請用繁體中文，條列、精準、短句。不確定時請先釐清。';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_LINE_LEN = 4800;

// ===== 工具：截斷避免超長 =====
function cut(text, n = MAX_LINE_LEN) {
  if (!text) return '';
  return text.length > n ? text.slice(0, n) : text;
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
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`LINE reply error: ${r.status} ${t}`);
  }
}

// ===== 入口（使用 ctx.waitUntil 觸發後送，不等待）=====
export default async function handler(req, ctx) {
  try {
    // 健康檢查 / Verify
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await req.json().catch(() => ({}));

    // Verify 送空 events → 立刻回 200
    if (Array.isArray(body?.events) && body.events.length === 0) {
      return new Response('OK', { status: 200 });
    }

    const ev = Array.isArray(body?.events) ? body.events[0] : null; // 只處理第一個事件，降低延遲
    if (!ev) return new Response('OK', { status: 200 });

    if (ev.type === 'message' && ev.message?.type === 'text') {
      const replyToken = ev.replyToken;
      const userText = (ev.message.text || '').trim();
      const userId = ev.source?.userId || null;

      // ① 先秒回，確保 webhook < 2s 結束
      try {
        await replyToLine(replyToken, '我來幫你查，約 5–10 秒後給完整答案👌');
      } catch (e) {
        console.error('reply first message failed:', e);
      }

      // ② 觸發 /api/push（帶 X-Auth）；不要 await，交給平台在回應後繼續跑
      try {
        const origin = new URL(req.url).origin;
        const p = fetch(`${origin}/api/push`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth': process.env.PUSH_SECRET || ''   // <— 一定要有，/api/push 會驗
          },
          body: JSON.stringify({
            userId,
            prompt: userText,
            system: SYSTEM_PROMPT,
            model: OPENAI_MODEL
          })
        }).catch(err => console.error('trigger push failed:', err));

        ctx?.waitUntil?.(p); // 讓它在背景跑，不阻塞回應
      } catch (e) {
        console.error('schedule push failed:', e);
      }

      // ③ 立刻回 200（關鍵：不等 push）
      return new Response('OK', { status: 200 });
    }

    // 非文字訊息：回一則提示
    if (ev.type === 'message') {
      try { await replyToLine(ev.replyToken, '目前僅支援文字訊息喔。'); } catch {}
    } else if (ev.type === 'follow') {
      try { await replyToLine(ev.replyToken, '感謝加入！直接輸入您的問題，我會盡力協助。'); } catch {}
    } else if (ev.type === 'join') {
      try { await replyToLine(ev.replyToken, '大家好～我可以協助回答常見問題！'); } catch {}
    }

    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('Handler error:', e);
    // 為了避免 LINE 重送造成雪崩，即使錯誤也回 200
    return new Response('OK', { status: 200 });
  }
}
