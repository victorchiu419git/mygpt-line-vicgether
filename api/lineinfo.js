export const config = { runtime: 'nodejs18.x', regions: ['hnd1'] }; // Tokyo

export default async function handler(req, res) {
  try {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
    if (!token) return res.status(200).json({ ok: false, reason: 'missing LINE_CHANNEL_ACCESS_TOKEN' });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), 8000); // 8s 逾時
    let ok = false, status = 0, body = '';
    try {
      const r = await fetch('https://api.line.me/v2/bot/info', {
        signal: ctrl.signal,
        headers: { 'Authorization': `Bearer ${token}` }
      });
      ok = r.ok; status = r.status; body = await r.text();
    } catch (e) {
      body = e?.name || String(e);
    } finally {
      clearTimeout(timer);
    }
    return res.status(200).json({ ok, status, body: (body || '').slice(0, 2000) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
