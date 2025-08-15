export const config = { runtime: 'edge' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '你是某品牌的官方客服助理，使用繁體中文，回答精準、簡短、條列，無答案時請禮貌詢問更多資訊。';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

function truncateForLine(text, max = 4800) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

async function askOpenAI(userText) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText }
      ]
    })
  });
  if (!resp.ok) throw new Error(`OpenAI API error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || '（沒有產生回覆）';
}

async function replyToLine(replyToken, text) {
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text: truncateForLine(text) }]
    })
  });
  if (!r.ok) throw new Error(`LINE reply error: ${r.status} ${await r.text()}`);
}

export default async function handler(req) {
  try {
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await req.json().catch(() => ({}));
    const events = body?.events || [];
    await Promise.all(events.map(async (ev) => {
      try {
        if (ev.type === 'message') {
          const replyToken = ev.replyToken;
          if (ev.message?.type === 'text') {
            const answer = await askOpenAI(ev.message.text?.trim() || '');
            await replyToLine(replyToken, answer);
          } else {
            await replyToLine(replyToken, '目前僅支援文字訊息喔。');
          }
        } else if (ev.type === 'follow') {
          await replyToLine(ev.replyToken, '感謝加入！請直接輸入您的問題，我會盡力協助。');
        } else if (ev.type === 'join') {
          await replyToLine(ev.replyToken, '大家好～我可以協助回答常見問題！');
        }
      } catch (e) { console.error('Event error:', e); }
    }));
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('Handler error:', e);
    return new Response('OK', { status: 200 });
  }
}
