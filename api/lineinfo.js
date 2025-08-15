export const config = { runtime: 'edge' };

export default async function handler() {
  try {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
    if (!token) {
      return new Response(JSON.stringify({ ok:false, reason:'missing LINE_CHANNEL_ACCESS_TOKEN' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    const r = await fetch('https://api.line.me/v2/bot/info', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const text = await r.text();
    return new Response(JSON.stringify({ ok: r.ok, status: r.status, body: text.slice(0,3000) }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error: e?.name || String(e) }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
}
