// api/lineinfo.js
export const config = { runtime: 'nodejs18.x' }; // 不指定 regions，避免建置限制

function timeoutFetch(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort('timeout'), ms);
  return fetch(url, { ...opts, signal: ctrl.signal })
    .then(async r => ({ ok: r.ok, status: r.status, body: (await r.text()).slice(0, 2000) }))
    .catch(e => ({ ok: false, error: e?.name || String(e) }))
    .finally(() => clearTimeout(t));
}

export default async function handler(req, res) {
  try {
    const token = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
    const env = {
      vercelEnv: process.env.VERCEL_ENV || 'unknown',
      region: process.env.VERCEL_REGION || 'unknown',
      hasToken: token.length > 0,
      tokenLen: token.length,
    };

    // A) 測「帶 Token」的官方檢查端點
    const a = token
      ? await timeoutFetch('https://api.line.me/v2/bot/info', {
          headers: { Authorization: `Bearer ${token}` }
        }, 12000) // 12s 上限
      : { ok: false, error: 'missing-token' };

    // B) 測「不帶 Token」打 LINE 根網域（只驗連線，不論授權）
    const b = await timeoutFetch('https://api.line.me/', {}, 7000);

    // C) 測一般外網（httpbin）
    const c = await timeoutFetch('https://httpbin.org/get', {}, 7000);

    return res.status(200).json({ env, apiLineInfo: a, apiLineRoot: b, httpbin: c });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
