// api/now.js
export const config = { runtime: 'nodejs18.x' };
export default async function handler(req, res) {
  res.status(200).json({ ok: true, ts: Date.now(), env: process.env.VERCEL_ENV || 'unknown' });
}
