// api/lineinfo.js
export default async function handler(req, res) {
  try {
    const token = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
    if (!token) {
      return res
        .status(200)
        .json({ ok: false, reason: 'missing LINE_CHANNEL_ACCESS_TOKEN (Production env)' });
    }

    // 8 秒硬性逾時，避免 504
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), 8000);

    let resp, text = '';
    try {
      resp = await fetch('https://api.line.me/v2/bot/info', {
        method: 'GET',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}` }
      });
      text = await resp.text();
    } catch (e) {
      clearTimeout(timer);
      return res.status(200).json({ ok: false, networkError: e?.name || String(e) });
    } finally {
      clearTimeout(timer);
    }

    return res.status(200).json({
      ok: resp.ok,
      status: resp.status,        // 200=token 有效；401=token 不對/過期
      body: (text || '').slice(0, 2000)
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
