export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '你是官方 LINE 客服助理，繁中、條列、精準。';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const MAX_LINE = 4800;

// 短訊（先回覆，保證 < 2s）
async function replyToLine(replyToken, text) {
  const payload = { replyToken, messages: [{ type: 'text', text: text.slice(0, MAX_LINE) }] };
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`LINE reply error: ${r.status} ${await r.text()}`);
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await req.json().catch(() => ({}));

    // Verify / 健康檢查：events 空 → 立即 200
    if (Array.isArray(body?.events) && body.events.length === 0) {
      return new Response('OK', { status: 200 });
    }

    const ev = Array.isArray(body?.events) ? body.events[0] : null;
    if (!ev) return new Response('OK', { status: 200 });

    // 只處理文字訊息
    if (ev.type === 'message' && ev.message?.type === 'text') {
      const userText = (ev.message.text || '').trim();
      const replyToken = ev.replyToken;
      const userId = ev.source?.userId || null;

      // ① 先回一則「我在處理」
      try {
        await replyToLine(replyToken, '我來幫你查，約 5–10 秒後給完整答案👌');
      } catch (e) {
        console.error('reply first message failed:', e);
      }

      // ② 立刻呼叫自己的 /api/push（不要 await，避免拖時間）
      try {
        const origin = new URL(req.url).origin;
        await fetch(`${origin}/api/push`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth': process.env.PUSH_SECRET || ''
          },
          body: JSON.stringify({
            userId,
            prompt: userText,
            system: SYSTEM_PROMPT,
            model: OPENAI_MODEL
          })
        });
      } catch (e) {
        console.error('trigger push failed:', e);
      }

      // ③ 立刻回 200（關鍵）
      return new Response('OK', { status: 200 });
    }

    // 非文字：回一則說明
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
    return new Response('OK', { status: 200 });
  }
}
