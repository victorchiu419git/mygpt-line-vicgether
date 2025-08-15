export const config = { runtime: 'edge' };

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const OPENAI_TIMEOUT_MS = 18000; // 最多等 18s
const MAX_TOKENS = 256;
const MAX_LINE = 4800;

function cut(t, n = MAX_LINE) { return t && t.length > n ? t.slice(0, n) : (t || ''); }

async function askOpenAI({ system, prompt, model }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), OPENAI_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
      })
    });

    if (r.status === 429) {
      let code = '';
      try { code = (await r.json())?.error?.code || ''; } catch {}
      return code === 'insufficient_quota'
        ? '（AI 服務額度不足或未開通付款，請稍後再試或轉人工協助）'
        : '（目前請求較多，稍候幾秒再試）';
    }
    if (!r.ok) {
      const t = await r.text().catch(()=> '');
      throw new Error(`OpenAI API error: ${r.status} ${t}`);
    }
    const data = await r.json();
    return data?.choices?.[0]?.message?.content?.trim() || '（沒有產生回覆）';
  } catch (e) {
    if (e?.name === 'AbortError' || e === 'timeout') return '（系統稍忙，我再想一下，請稍後再試或改問更精準的問題）';
    throw e;
  } finally { clearTimeout(timer); }
}

async function pushToLine(userId, text) {
  const payload = { to: userId, messages: [{ type: 'text', text: cut(text) }] };
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`LINE push error: ${r.status} ${await r.text()}`);
}

export default async function handler(req) {
  try {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // 簡單防護：內部呼叫才允許
    const key = req.headers.get('X-Auth') || '';
    if (!process.env.PUSH_SECRET || key !== process.env.PUSH_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    const { userId, prompt, system, model } = await req.json().catch(() => ({}));
    if (!userId || !prompt) return new Response('Bad Request', { status: 400 });

    const answer = await askOpenAI({ system, prompt, model });
    await pushToLine(userId, answer);

    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('Push handler error:', e);
    return new Response('OK', { status: 200 });
  }
}
