// api/now.js
export default async function handler(req, res) {
  try {
    return res.status(200).json({ ok: true, ts: Date.now() });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
