// api/webhook.js — 總控路由 + 轉人工冷卻
// 需要（Production 環境變數）：
// OPENAI_API_KEY, LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, VENDOR_WEBHOOK
// 可選：OPENAI_MODEL, SYSTEM_PROMPT, FORWARD_FALLBACK_ON_ERROR=1, HUMAN_SNOOZE_MIN=15

const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET  = process.env.LINE_CHANNEL_SECRET;
const VENDOR_URL   = (process.env.VENDOR_WEBHOOK || '').trim();

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  '你是「VicGether 亦啟科技 / POWAH」的 LINE 客服助理。請用繁體中文、先給結論一句，再條列 2–4 點重點；不確定先釐清。';

const FORWARD_FALLBACK_ON_ERROR = (process.env.FORWARD_FALLBACK_ON_ERROR || '') === '1';
const SNOOZE_MIN = parseInt(process.env.HUMAN_SNOOZE_MIN || '15', 10);

const MAX_LEN = 4800;
const AI_TIMEOUT_MS     = 5000;  // 5s 取 AI
const REPLY_TIMEOUT_MS  = 4000;  // 4s 回 LINE
const VENDOR_TIMEOUT_MS = 6000;  // 6s 轉發外包

// 轉人工：記憶目前實例的使用者冷卻（如需跨實例，之後可換 Redis/KV）
const snooze = new Map();

const cut = (t, n = MAX_LEN) => (t && t.length > n ? t.slice(0, n) : (t || ''));

// 讀原始 POST body（Node）
function readRaw(req) {
  return new Promise((resolve) => {
    try {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
      req.on('error', () => resolve(''));
    } catch { resolve(''); }
  });
}

// ---- 意圖判斷 ----
function isOrderIntent(text = '') {
  const t = text.trim();
  if (!t) return false;
  const kw = /(查(詢)?訂單|訂單|出貨|物流|配送|進度|order)/i;
  const id = /(#\d{4,}|(?:20)?\d{6,}|PO[-\w]{4,})/i;
  return kw.test(t) || id.test(t);
}
function isHumanIntent(t='') {
  return /(人工|真人|客服|接線|人員協助|找人)/i.test(t);
}
function isHumanResumeIntent(t='') {
  return /(解除|取消|恢復).*(人工|機器人|自動|AI)/i.test(t);
}
function isSnoozed(userId='') {
  const until = snooze.get(userId) || 0;
  return Date.now() < until;
}

// ---- 代簽並轉發到外包 Webhook ----
async function forwardToVendorWebhook(rawBody) {
  if (!VENDOR_URL || !LINE_SECRET) return { ok:false, reason:'missing vendor or secret' };
  const { createHmac } = await import('crypto');
  const signature = createHmac('sha256', LINE_SECRET).update(rawBody).digest('base64');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), VENDOR_TIMEOUT_MS);
  try {
    const r = await fetch(VENDOR_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': signature
      },
      body: rawBody
    });
    const txt = await r.text().catch(()=> '');
    return { ok: r.ok, status: r.status, body: (txt || '').slice(0, 500) };
  } catch (e) {
    return { ok:false, reason: e?.name || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- OpenAI（5s）----
async function askOpenAI(userText) {
  if (!OPENAI_KEY) return '（AI 金鑰未設定，請稍後再試或轉人工）';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), AI_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText }
        ]
      })
    });
    if (r.status === 429) {
      let code=''; try { code=(await r.json())?.error?.code || ''; } catch {}
      return code==='insufficient_quota'
        ? '（AI 服務額度不足或未完成付款設定，請稍後再試或改由人工協助）'
        : '（目前請求較多，請稍候幾秒再試）';
    }
    if (!r.ok) return `（AI 服務暫時無法使用：${r.status}）`;
    const data = await r.json();
    return data?.choices?.[0]?.message?.content?.trim() || '（沒有產生可用回覆）';
  } catch (e) {
    if (e?.name === 'AbortError') return '（系統稍忙，我再想一下，請稍後再試或改問更精準的問題）';
    return '（系統暫時發生問題，請稍後再試）';
  } finally { clearTimeout(timer); }
}

// ---- 回 LINE（4s）----
async function replyToLine(replyToken, text, debug = {}) {
  if (!replyToken || !LINE_TOKEN) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), REPLY_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: cut(text) }] })
    });
    const body = await r.text().catch(()=> '');
    if (!r.ok) console.error('REPLY_FAIL', { status: r.status, body, debug });
    else console.log('REPLY_OK', { status: r.status, debug });
  } catch (e) {
    console.error('REPLY_ERR', { error: e?.name || String(e), debug });
  } finally { clearTimeout(timer); }
}

// ---- 入口 ----
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(200).send('OK');

    const raw = await readRaw(req);
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const ev = Array.isArray(body?.events) ? body.events[0] : null;

    if (ev?.type === 'message' && ev.message?.type === 'text') {
      const replyToken = ev.replyToken;
      const userText   = (ev.message.text || '').trim();
      const mode       = ev.mode || '(unknown)';
      const userId     = ev.source?.userId || '(none)';
      const debugBase  = { mode, userIdTail: userId.slice(-6) };

      // 0) 轉人工指令 → 設冷卻
      if (isHumanIntent(userText)) {
        snooze.set(userId, Date.now() + SNOOZE_MIN * 60 * 1000);
        await replyToLine(
          replyToken,
          `已為您轉接人工服務（約【${SNOOZE_MIN} 分鐘】有效）。您可以直接在此輸入問題，稍後由專員回覆。`,
          { ...debugBase, route:'human-on' }
        );
        return res.status(200).send('OK');
      }

      // 0.1) 解除人工 → 清冷卻
      if (isHumanResumeIntent(userText)) {
        snooze.delete(userId);
        await replyToLine(replyToken, '已結束人工模式，恢復機器回覆。', { ...debugBase, route:'human-off' });
        return res.status(200).send('OK');
      }

      // 1) 冷卻期間 → 不回覆（留給業務）
      if (isSnoozed(userId)) {
        console.log('HUMAN_SNOOZED', debugBase);
        return res.status(200).send('OK');
      }

      // 2) 查訂單 → 代簽名轉發給外包（由外包使用 replyToken 回覆）
      if (isOrderIntent(userText)) {
        const fwd = await forwardToVendorWebhook(raw);
        console.log('FORWARD_VENDOR', { ok: fwd.ok, status: fwd.status || '-', reason: fwd.reason || '-' });
        if (!fwd.ok && FORWARD_FALLBACK_ON_ERROR) {
          await replyToLine(
            replyToken,
            '查詢系統暫時忙碌，請提供【訂單編號】或【訂購電話後四碼】，我先幫您人工查詢。',
            { ...debugBase, route:'vendor-fallback' }
          );
        }
        return res.status(200).send('OK');
      }

      // 3) 其他 → AI 回覆
      const ans = await askOpenAI(userText);
      await replyToLine(replyToken, ans, { ...debugBase, route:'ai' });
      return res.status(200).send('OK');
    }

    // 非文字訊息
    if (ev?.type === 'message') {
      await replyToLine(ev.replyToken, '目前僅支援文字訊息喔。', { route:'non-text' });
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error('WEBHOOK_ERR', e?.message || e);
    return res.status(200).send('OK');
  }
}
