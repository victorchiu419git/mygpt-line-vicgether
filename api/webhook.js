export const config = { runtime: 'edge' };

// === LINE 設定 ===
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const MAX_LEN = 4800; // 避免超過 LINE 單則訊息上限（保守值）

function cut(t, n = MAX_LEN) { return t && t.length > n ? t.slice(0, n) : (t || ''); }

// 先秒回一則（Reply API；不經 OpenAI）
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

export default async function handler(req, ctx) {
  try {
    // 健康檢查 / Verify
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await req.json().catch(() => ({}));
    const ev = Array.isArray(body?.events) ? body.events[0] : null;

    // Verify 或無事件 → 立刻回 200
    if (!ev) return new Response('OK', { status: 200 });

    // 只處理「文字訊息」
    if (ev.type === 'message' && ev.message?.type === 'text') {
      const replyToken = ev.replyToken;
      const userId = ev.source?.userId || '';
      const userText = (ev.message.text || '').trim();

      // ① 先「秒回」一句固定話（一定 < 1–2s 完成）
      try {
        await replyToLine(replyToken, '已收到，我正在處理，稍後提供完整答案。');
      } catch (e) {
        console.error('reply ack failed:', e);
      }

      // ② 背景觸發 /api/push 產生完整答案（不要 await）
      try {
        const origin = new URL(req.url).origin;
        const p = fetch(`${origin}/api/push`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth': process.env.PUSH_SECRET || '' // 與 /api/push 驗證一致
          },
          body: JSON.stringify({
            userId,
            prompt: userText,
            system: process.env.SYSTEM_PROMPT ||
                    '你是官方 LINE 客服助理，繁體中文、條列、精準、短句。不確定先釐清。',
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
          })
        }).catch(err => console.error('trigger push failed:', err));

        // 若平台支援，讓它在回應後持續執行
        ctx?.waitUntil?.(p);
      } catch (e) {
        console.error('schedule push failed:', e);
      }

      // ③ 關鍵：不等待任何外部呼叫，**立刻回 200**
      return new Response('OK', { status: 200 });
    }

    // 其他事件（貼圖/圖片/加入/群組等）→ 不阻塞，直接 200
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('webhook error:', e);
    // 為避免 LINE 重送造成雪崩，即使錯誤也回 200
    return new Response('OK', { status: 200 });
  }
}
