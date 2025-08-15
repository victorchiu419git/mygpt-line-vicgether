// api/now.js  — Edge 極簡健康檢查
export const config = { runtime: 'edge' };

export default async function handler() {
  return new Response(
    JSON.stringify({ ok: true, ts: Date.now() }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}
