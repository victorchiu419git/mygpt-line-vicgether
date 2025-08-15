export const config = { runtime: 'edge' };

export default async function handler(req, ctx) {
  try {
    // 健康檢查
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // 讀事件
    const body = await req.json().catch(() => ({}));
    const ev = Array.isArray(body?.events) ? body.events[0] : null;
    if (!ev) return new Response('OK', { status: 200 });

    // 僅處理文字訊息；其餘直接 200
    if (ev.type === 'message' && ev.message?.type === 'text') {
      const origin = new URL(req.url).origin;
      const userId = ev.source?.userId || '';
      const userText = (ev.message.text || '').trim();
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const system =
        process.env.SYSTEM_PROMPT ||
        '你是官方 LINE 客服助理，繁體中文、條列、精準、短句。不確定先釐清。';

      // ① 先推一則「已收到」（不要 await）
      ctx?.waitUntil?.(
        fetch(`${origin}/api/push`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth': process.env.PUSH_SECRET || ''
          },
          body: JSON.stringify({
            userId,
            prompt: '請用最短一句話回覆：已收到，我正在處理，稍後提供完整答案。',
            system: '你是客服，繁體中文，只輸出一句提示，不要多餘說明。',
            model
          })
        }).catch(e => console.error('trigger ack failed:', e))
      );

      // ② 再推完整答案（不要 await）
      ctx?.waitUntil?.(
        fetch(`${origin}/api/push`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth': process.env.PUSH_SECRET || ''
          },
          body: JSON.stringify({ userId, prompt: userText, system, model })
        }).catch(e => console.error('trigger full failed:', e))
      );

      // ③ 立刻回 200（關鍵：不等待任何外部呼叫）
      return new Response('OK', { status: 200 });
    }

    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('webhook error:', e);
    return new Response('OK', { status: 200 });
  }
}
