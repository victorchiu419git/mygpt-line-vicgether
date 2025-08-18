// api/webhook.js — AI 回覆 + 外包 Web Light 轉發 + 查訂單 + 轉人工冷卻 + 歡迎/招呼 + 非文字/低資訊 + 逾時保護
// 必填（Production 環境變數）:
// OPENAI_API_KEY, LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, VENDOR_WEBHOOK
// 選填：OPENAI_MODEL, SYSTEM_PROMPT, SUPPORT_EMAIL, HUMAN_SNOOZE_MIN=15, FORWARD_FALLBACK_ON_ERROR=1

// ---- 環境變數 ----
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET  = process.env.LINE_CHANNEL_SECRET;
const VENDOR_URL   = (process.env.VENDOR_WEBHOOK || '').trim();

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  '你是「VicGether Tech. / 亦啟科技 / POWAH」的 LINE 官方ai客服助理。請用繁體中文、先給結論一句，再條列 2–4 點重點；不確定先釐清。';

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'service@vicgether.com';
const SNOOZE_MIN = parseInt(process.env.HUMAN_SNOOZE_MIN || '15', 10);
const FORWARD_FALLBACK_ON_ERROR = (process.env.FORWARD_FALLBACK_ON_ERROR || '') === '1';

// ---- 逾時與雜項 ----
const MAX_LEN = 4800;
const AI_TIMEOUT_MS     = 5000;  // 5s 取 AI
const REPLY_TIMEOUT_MS  = 4000;  // 4s 回 LINE
const VENDOR_TIMEOUT_MS = 6000;  // 6s 轉發外包

const snooze = new Map(); // 轉人工冷卻（若要跨實例，之後可換 Redis/KV）
const cut = (t, n = MAX_LEN) => (t && t.length > n ? t.slice(0, n) : (t || ''));

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
  const t = (text || '').trim();
  if (!t) return false;
  const kw = /(查(詢)?訂單|訂單|出貨|物流|配送|進度|order)/i;
  const id = /(#\d{4,}|(?:20)?\d{6,}|PO[-\w]{4,})/i;
  return kw.test(t) || id.test(t);
}
function isHumanIntent(t='') {
  return /(人工|真人|客服|接線|人員協助|找人)/i.test(t || '');
}
function isHumanResumeIntent(t='') {
  return /(解除|取消|恢復).*(人工|機器|自動|AI)/i.test(t || '');
}
// Web Light 關鍵字：綁定會員/優惠券/紅利點數/產品/文章/LINE登入 等（不含「訂單」：訂單另有路由）
function isVendorIntent(t='') {
  if (!t) return false;
  const hasOrder = isOrderIntent(t);
  const vendorKW = /(綁定會員|綁定|會員|優惠券|折價券|紅利|點數|積分|產品|文章|關鍵字|登入|line ?登入)/i;
  return vendorKW.test(t) && !hasOrder;
}
// 低資訊：移除空白/標點/符號後，剩下可判讀字元 < 2（英數或中日韓）
function isLowInfoText(t='') {
  const meaningful = (t.match(/[A-Za-z0-9\u4e00-\u9fff]/g) || []).length;
  return meaningful < 2;
}
// 是否在轉人工冷卻期間
function isSnoozed(userId='') {
  const until = snooze.get(userId) || 0;
  return Date.now() < until;
}
// 純打招呼意圖（Hi/Hello/嗨/你好…）
function isHelloIntent(t = '') {
  return /^[\s]*(hi|hello|hey|嗨|哈囉|哈啰|你好|午安|早安|晚安)[\s!！。,.～~]*$/i.test(t || '');
}

// ---- LINE Reply（單則）----
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

// ---- LINE Reply（多則，含 quickReply 用）----
async function replyMessages(replyToken, messages, debug = {}) {
  if (!replyToken || !LINE_TOKEN) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), REPLY_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken, messages })
    });
    const body = await r.text().catch(()=> '');
    if (!r.ok) console.error('REPLY_FAIL', { status: r.status, body, debug });
    else console.log('REPLY_OK', { status: r.status, debug });
  } catch (e) {
    console.error('REPLY_ERR', { error: e?.name || String(e), debug });
  } finally { clearTimeout(timer); }
}

// ---- 代簽並轉發到外包 Webhook（原封不動送過去）----
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

// ---- 入口 ----
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(200).send('OK');

    const raw = await readRaw(req);
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const ev = Array.isArray(body?.events) ? body.events[0] : null;

    if (ev) {
      const mode = ev.mode || '(unknown)';
      const userId = ev.source?.userId || '(none)';
      console.log('EVENT_MODE', {
        mode,
        userIdTail: userId.slice(-6),
        hasKey: !!OPENAI_KEY,
        hasLine: !!LINE_TOKEN,
        hasSecret: !!LINE_SECRET,
        hasVendor: !!VENDOR_URL
      });

      // ---- 文字訊息 ----
      if (ev.type === 'message' && ev.message?.type === 'text') {
        const replyToken = ev.replyToken;
        const userText   = (ev.message.text || '').trim();
        const debugBase  = { mode, userIdTail: userId.slice(-6) };

        // 0) 轉人工：設冷卻
        if (isHumanIntent(userText)) {
          snooze.set(userId, Date.now() + SNOOZE_MIN * 60 * 1000);
          await replyToLine(
            replyToken,
            `已為您轉接人工服務（約【${SNOOZE_MIN} 分鐘】有效）。\n您可以直接在此輸入問題；若需附檔，亦可寄至【${SUPPORT_EMAIL}】（請註明 LINE 暱稱＋問題摘要）。`,
            { ...debugBase, route:'human-on' }
          );
          return res.status(200).send('OK');
        }

        // 0.1) 解除人工：清冷卻
        if (isHumanResumeIntent(userText)) {
          snooze.delete(userId);
          await replyToLine(replyToken, '已結束人工模式，恢復機器回覆。', { ...debugBase, route:'human-off' });
          return res.status(200).send('OK');
        }

        // 1) 冷卻期間：不回覆（留給業務）
        if (isSnoozed(userId)) {
          console.log('HUMAN_SNOOZED', debugBase);
          return res.status(200).send('OK');
        }

        // 1.0) 純打招呼：回友善歡迎＋ Quick Reply（不丟給 AI）
        if (isHelloIntent(userText)) {
          const msg1 = {
            type: 'text',
            text:
`嗨～我是【亦啟科技｜VicGether Tech.｜POWAH】AI 助理。
想開始：
- 查配送/進度 → 回覆【查訂單】（附【訂單編號】或【電話後四碼】更快）
- 產品諮詢/安裝相容 → 回覆【產品諮詢】
- 需要真人 → 回覆【我要人工】
也可寄至【${SUPPORT_EMAIL}】。`
          };
          const msg2 = {
            type: 'text',
            text: '可以用下方快速按鈕開始：',
            quickReply: {
              items: [
                { type: 'action', action: { type: 'message', label: '查訂單',   text: '查訂單' } },
                { type: 'action', action: { type: 'message', label: '產品諮詢', text: '產品諮詢' } },
                { type: 'action', action: { type: 'message', label: '我要人工', text: '我要人工' } },
                { type: 'action', action: { type: 'message', label: '綁定會員', text: '綁定會員' } }
              ]
            }
          };
          await replyMessages(replyToken, [msg1, msg2], { ...debugBase, route: 'hello' });
          return res.status(200).send('OK');
        }

        // 1.1) 低資訊文字：固定提示
        if (isLowInfoText(userText)) {
          await replyToLine(
            replyToken,
            `目前僅支援文字訊息喔。\n請以文字描述需求（例：「保固申請」「安裝教學」「查訂單 12345」）；若需附檔，亦可寄至【${SUPPORT_EMAIL}】。`,
            { ...debugBase, route:'low-info' }
          );
          return res.status(200).send('OK');
        }

        // 2) 訂單：代簽名轉發（由外包回覆）
        if (isOrderIntent(userText)) {
          const fwd = await forwardToVendorWebhook(raw);
          console.log('FORWARD_VENDOR(order)', { ok: fwd.ok, status: fwd.status || '-', reason: fwd.reason || '-' });
          if (!fwd.ok && FORWARD_FALLBACK_ON_ERROR) {
            await replyToLine(
              replyToken,
              `查詢系統暫時忙碌，我先協助改走人工。\n請提供【訂單編號】或【訂購電話後四碼】，或將資訊寄至【${SUPPORT_EMAIL}】（請註明 LINE 暱稱＋問題摘要）。`,
              { ...debugBase, route:'vendor-fallback-order' }
            );
          }
          return res.status(200).send('OK');
        }

        // 2.1) Web Light 其他關鍵字：綁定會員/優惠券/紅利點數/產品/文章/登入… → 也轉外包
        if (isVendorIntent(userText)) {
          const fwd = await forwardToVendorWebhook(raw);
          console.log('FORWARD_VENDOR(vendorKW)', { ok: fwd.ok, status: fwd.status || '-', reason: fwd.reason || '-' });
          if (!fwd.ok && FORWARD_FALLBACK_ON_ERROR) {
            await replyToLine(
              replyToken,
              `目前系統較忙，我先協助改走人工。\n您可直接輸入需求（例：「綁定會員」「查優惠券」「查紅利點數」），或寄至【${SUPPORT_EMAIL}】。`,
              { ...debugBase, route:'vendor-fallback-kw' }
            );
          }
          return res.status(200).send('OK');
        }

        // 3) 其他：AI 回覆
        const ans = await askOpenAI(userText);
        await replyToLine(replyToken, ans, { ...debugBase, route:'ai' });
        return res.status(200).send('OK');
      }

      // ---- 非文字訊息（貼圖/圖片/語音/影片/位置/檔案等）----
      if (ev.type === 'message') {
        await replyToLine(
          ev.replyToken,
          `目前僅支援文字訊息喔。\n請以文字描述需求（例：「保固申請」「安裝教學」「查訂單 12345」）；若需附檔，亦可寄至【${SUPPORT_EMAIL}】。`,
          { route:'non-text', userIdTail: (ev.source?.userId || '').slice(-6) }
        );
        return res.status(200).send('OK');
      }

      // ---- 加好友（follow）：新版歡迎詞 + 4 顆 Quick Reply ----
      if (ev.type === 'follow') {
        const msg1 = {
          type: 'text',
          text:
`歡迎加入【亦啟科技｜VicGether Tech.｜POWAH】官方帳號！🎉
這裡會不定期分享你不想錯過的【最新消息】與【小技巧】。
想開始：
- 查配送/進度 → 輸入【查訂單】（附【訂單編號】或【電話後四碼】更快）
- 產品諮詢/安裝相容 → 輸入【產品諮詢】
- 要真人協助 → 輸入【人工】
- 綁定會員 → 輸入【綁定會員】（或點下方按鈕）
需要附檔或詳述，也可寄至【${SUPPORT_EMAIL}】。
請問還有什麼地方需要我幫忙的嗎？`
        };
        const msg2 = {
          type: 'text',
          text: '可以用下方快速按鈕開始：',
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '查訂單',   text: '查訂單' } },
              { type: 'action', action: { type: 'message', label: '產品諮詢', text: '產品諮詢' } },
              { type: 'action', action: { type: 'message', label: '我要人工', text: '我要人工' } },
              { type: 'action', action: { type: 'message', label: '綁定會員', text: '綁定會員' } }
            ]
          }
        };
        await replyMessages(ev.replyToken, [msg1, msg2], { route:'follow' });
        return res.status(200).send('OK');
      }
    }

    // 其他事件：一律 200，避免重送
    return res.status(200).send('OK');
  } catch (e) {
    console.error('WEBHOOK_ERR', e?.message || e);
    return res.status(200).send('OK');
  }
}
