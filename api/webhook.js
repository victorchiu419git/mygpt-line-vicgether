export const config = { runtime: 'edge' };

// ……(上面常數/工具函式維持不變)

export default async function handler(req, ctx) {   // <── 多了 ctx
  try {
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await req.json().catch(() => ({}));
    if (Array.isArray(body?.events) && body.events.length === 0) {
      return new Response('OK', { status: 200 });   // Verify 立刻回
    }

    const ev = Array.isArray(body?.events) ? body.events[0] : null;
    if (!ev) return new Response('OK', { status: 200 });

    if (ev.type === 'message' && ev.message?.type === 'text') {
      const replyToken = ev.replyToken;
      const userText = (ev.message.text || '').trim();
      const userId = ev.source?.userId || null;

      // ① 先秒回一則
      await replyToLine(replyToken, '我來幫你查，約 5–10 秒後給完整答案👌');

      // ② 透過 waitUntil 觸發 /api/push（不要 await）
      const origin = new URL(req.url).origin;
      const p = fetch(`${origin}/api/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth': process.env.PUSH_SECRET || ''
        },
        body: JSON.stringify({
          userId,
          prompt: userText,
          system: process.env.SYSTEM_PROMPT || '你是官方 LINE 客服助理，繁中、條列、精準。',
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
        })
      }).catch(err => console.error('trigger push failed:', err));

      ctx?.waitUntil?.(p);  // <── 關鍵：讓它在回應後繼續跑
      return new Response('OK', { status: 200 });   // ③ 立即回 200
    }

    // 非文字的快速回覆
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
