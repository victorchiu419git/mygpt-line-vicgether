export const config = { runtime: 'edge' };

export default async function handler(req, ctx) {
  try {
    // 健康檢查
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // 讀原始字串，避免 JSON 解析阻塞；解析失敗也不影響回 200
    const raw = await req.text().catch(() => '');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}

    const events = Array.isArray(body?.events) ? body.events : [];
    const ev = events[0];
    if (ev && ev.type === 'message' && ev.message?.type === 'text') {
      const userId = ev.source?.userId || '';
      const userText = (ev.message.text || '').trim();
      const origin = new URL(req.url).origin;
      const model  = process.env.OPENAI_MODEL   || 'gpt-4o-mini';
      const system = process.env.SYSTEM_PROMPT || '你是官方 LINE 客服助理，繁體中文、條列、精準、短句。不確定先釐清。';
      const auth   = process.env.PUSH_SECRET    || '';

      // 只在有 ctx 時才排程（不要在這裡先 fetch，再交給 waitUntil！）
      if (ctx && typeof ctx.waitUntil === 'function') {
        // ① 背景推一則「已收到」提示
        ctx.waitUntil(fetch(`${origin}/api/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Auth': auth },
          body: JSON.stringify({
            userId,
            prompt: '請用最短一句話回覆：已收到，我正在處理，稍後提供完整答案。',
            system: '你是客服，繁中，直接一句提示，不要多餘說明。',
            model
          })
        }).catch(err => console.error('ack push schedule failed:', err)));

        // ② 背景再推完整答案
        ctx.waitUntil(fetch(`${origin}/api/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Auth': auth },
          body: JSON.stringify({ userId, prompt: userText, system, model })
        }).catch(err => console.error('full push schedule failed:', err)));
      }
    }

    // ✅ 關鍵：不等待任何外部呼叫，立刻回 200
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('webhook error:', e);
    // 即使錯誤也回 200，避免 LINE 重送雪崩
    return new Response('OK', { status: 200 });
  }
}
