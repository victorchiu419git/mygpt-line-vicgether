// api/webhook.js — AI + Web Light/訂單：先 ACK → 轉外包；外包無回或太短→（依旗標）AI or 推官網備援
// 必填環境變數：OPENAI_API_KEY, LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, VENDOR_WEBHOOK
// 選填：OPENAI_MODEL, SYSTEM_PROMPT, SUPPORT_EMAIL, HUMAN_SNOOZE_MIN=15,
//       FORWARD_FALLBACK_ON_ERROR=1, VENDOR_KW_ACK=1, VENDOR_ORDER_ACK=1,
//       LOG_VENDOR_BODY=1, VENDOR_MEMBER_PORTAL_URL=https://..., VENDOR_MIN_TEXT_LEN=8

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
const VENDOR_KW_ACK = (process.env.VENDOR_KW_ACK || '1') === '1';
const VENDOR_ORDER_ACK = (process.env.VENDOR_ORDER_ACK || '1') === '1';
const LOG_VENDOR_BODY = (process.env.LOG_VENDOR_BODY || '') === '1';
const VENDOR_MEMBER_PORTAL_URL = (process.env.VENDOR_MEMBER_PORTAL_URL || '').trim();
const FALLBACK_URL = VENDOR_MEMBER_PORTAL_URL || 'https://www.vicgether.com';
const VENDOR_MIN_TEXT_LEN = parseInt(process.env.VENDOR_MIN_TEXT_LEN || '8', 10);

// ---- 逾時與雜項 ----
const MAX_LEN = 4800;
const AI_TIMEOUT_MS     = 5000;
const REPLY_TIMEOUT_MS  = 4000;
const VENDOR_TIMEOUT_MS = 6000;

const snooze = new Map();
const cut = (t, n = MAX_LEN) => (t && t.length > n ? t.slice(0, n) : (t || ''));

// ---- utils ----
function readRaw(req) {
  return new Promise((resolve) => {
    try {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => resolve(d));
      req.on('error', () => resolve(''));
    } catch { resolve(''); }
  });
}

// 新增：外包連線就緒檢查
function vendorReady() {
  return !!(VENDOR_URL && LINE_SECRET);
}

// ---- 意圖判斷 ----
function isOrderIntent(text='') {
  const t = (text || '').trim(); if (!t) return false;
  const kw = /(查(詢)?訂單|訂單|出貨|物流|配送|進度|order)/i;
  const id = /(#\d{4,}|(?:20)?\d{6,}|PO[-\w]{4,})/i;
  return kw.test(t) || id.test(t);
}
function isHumanIntent(t=''){ return /(人工|真人|客服|接線|人員協助|找人)/i.test(t||''); }
function isHumanResumeIntent(t=''){ return /(解除|取消|恢復).*(人工|機器|自動|AI)/i.test(t||''); }

// 調整：縮窄 vendor intent（僅會員/登入/優惠等明確網站任務；避免把一般問句丟外包）
function isVendorIntent(t=''){ // Web Light 關鍵字（非訂單）
  if (!t) return false;
  const hasOrder = isOrderIntent(t);
  const vendorKW = /(綁定會員|綁定|會員中心|會員|優惠券|折價券|紅利|點數|積分|登入|line ?登入|購物車|訂單查詢)/i;
  return vendorKW.test(t) && !hasOrder;
}

function isLowInfoText(t=''){ const m=(t.match(/[A-Za-z0-9\u4e00-\u9fff]/g)||[]).length; return m < 2; }
function isSnoozed(userId=''){ const until = snooze.get(userId) || 0; return Date.now() < until; }
function isHelloIntent(t=''){ return /^[\s]*(hi|hello|hey|嗨|哈囉|哈啰|你好|午安|早安|晚安)[\s!！。,.～~]*$/i.test(t||''); }

// ---- LINE 回覆/推播 ----
async function replyToLine(replyToken, textOrMsgs, debug = {}) {
  if (!replyToken || !LINE_TOKEN) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), REPLY_TIMEOUT_MS);
  const messages = Array.isArray(textOrMsgs) ? textOrMsgs : [{ type:'text', text: cut(textOrMsgs) }];
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

async function pushToLine(userId, textOrMsgs, debug = {}) {
  if (!userId || !LINE_TOKEN) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), REPLY_TIMEOUT_MS);
  const messages = Array.isArray(textOrMsgs) ? textOrMsgs : [{ type:'text', text: cut(textOrMsgs) }];
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: userId, messages })
    });
    const body = await r.text().catch(()=> '');
    if (!r.ok) console.error('PUSH_FAIL', { status: r.status, body, debug });
    else console.log('PUSH_OK', { status: r.status, debug });
  } catch (e) {
    console.error('PUSH_ERR', { error: e?.name || String(e), debug });
  } finally { clearTimeout(timer); }
}
async function replyMessages(replyToken, messages, debug={}) {
  return replyToLine(replyToken, messages, debug);
}

// ---- 轉外包（保持 raw 以供驗簽）----
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
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signature },
      body: rawBody
    });
    const txt = await r.text().catch(()=> '');
    if (LOG_VENDOR_BODY) {
      const snip = (txt || '').slice(0, 300).replace(/\s+/g, ' ').trim();
      console.log('VENDOR_BODY_SNIPPET', { len: (txt || '').length || 0, head: snip });
    }
    return { ok: r.ok, status: r.status, body: (txt || '').slice(0, 4000) };
  } catch (e) {
    return { ok:false, reason: e?.name || String(e) };
  } finally { clearTimeout(timer); }
}

// ---- 解析外包回應；太短則視為無效（走備援或 AI）----
function parseVendorBody(body) {
  if (!body) return null;
  // 1) JSON
  try {
    const j = JSON.parse(body);
    if (Array.isArray(j?.messages) && j.messages.length) {
      if (j.messages.length === 1 && j.messages[0]?.type === 'text') {
        const msg = (j.messages[0].text || '').trim();
        if (msg.length < VENDOR_MIN_TEXT_LEN) return null;
      }
      return j.messages.slice(0, 5);
    }
    if (typeof j?.replyText === 'string') {
      const txt = j.replyText.trim();
      if (txt.length < VENDOR_MIN_TEXT_LEN) return null;
      return [{ type:'text', text: txt.slice(0, MAX_LEN) }];
    }
    if (typeof j?.text === 'string') {
      const txt = j.text.trim();
      if (txt.length < VENDOR_MIN_TEXT_LEN) return null;
      return [{ type:'text', text: txt.slice(0, MAX_LEN) }];
    }
  } catch {}
  // 2) 純文字（去掉簡單 HTML）
  const plain = String(body).replace(/<[^>]+>/g, '').trim();
  if (plain && plain.length >= VENDOR_MIN_TEXT_LEN) {
    return [{ type:'text', text: cut(plain) }];
  }
  return null;
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
      let code = ''; try { code = (await r.json())?.error?.code || ''; } catch {}
      return code === 'insufficient_quota'
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

      // 文字訊息
      if (ev.type === 'message' && ev.message?.type === 'text') {
        const replyToken = ev.replyToken;
        const userText   = (ev.message.text || '').trim();
        const debugBase  = { mode, userIdTail: userId.slice(-6) };

        // 轉人工 / 解除人工 / 冷卻
        if (isHumanIntent(userText)) {
          snooze.set(userId, Date.now() + SNOOZE_MIN * 60 * 1000);
          await replyToLine(
            replyToken,
            `已為您轉接人工服務（約【${SNOOZE_MIN} 分鐘】有效）。\n您可以直接在此輸入問題；若需附檔，亦可寄至【${SUPPORT_EMAIL}】（請註明 LINE 暱稱＋問題摘要）。`,
            { ...debugBase, route:'human-on' }
          );
          return res.status(200).send('OK');
        }
        if (isHumanResumeIntent(userText)) {
          snooze.delete(userId);
          await replyToLine(replyToken, '已結束人工模式，恢復機器回覆。', { ...debugBase, route:'human-off' });
          return res.status(200).send('OK');
        }
        if (isSnoozed(userId)) {
          console.log('HUMAN_SNOOZED', debugBase);
          return res.status(200).send('OK');
        }

        // 招呼（不丟 AI）
        if (isHelloIntent(userText)) {
          const msg1 = { type:'text', text:
`嗨～我是【亦啟科技｜VicGether Tech.｜POWAH】AI 助理。
想開始：
- 查配送/進度 → 回覆【查訂單】（附【訂單編號】或【電話後四碼】更快）
- 產品諮詢/安裝相容 → 回覆【產品諮詢】
- 需要真人 → 回覆【我要人工】
也可寄至【${SUPPORT_EMAIL}】。` };
          const msg2 = {
            type:'text',
            text:'可以用下方快速按鈕開始：',
            quickReply:{ items:[
              { type:'action', action:{ type:'message', label:'查訂單',   text:'查訂單' } },
              { type:'action', action:{ type:'message', label:'產品諮詢', text:'產品諮詢' } },
              { type:'action', action:{ type:'message', label:'我要人工', text:'我要人工' } },
              { type:'action', action:{ type:'message', label:'綁定會員', text:'綁定會員' } }
            ]}
          };
          await replyMessages(replyToken, [msg1, msg2], { ...debugBase, route:'hello' });
          return res.status(200).send('OK');
        }

        // 低資訊
        if (isLowInfoText(userText)) {
          await replyToLine(
            replyToken,
            `目前僅支援文字訊息喔。\n請以文字描述需求（例：「保固申請」「安裝教學」「查訂單 12345」）；若需附檔，亦可寄至【${SUPPORT_EMAIL}】。`,
            { ...debugBase, route:'low-info' }
          );
          return res.status(200).send('OK');
        }

        // 訂單：ACK → 轉外包（raw 以便驗簽）→ 有內容就 push；無內容/太短→(依旗標)備援或AI
        if (isOrderIntent(userText)) {
          if (VENDOR_ORDER_ACK) {
            await replyToLine(
              replyToken,
              `已收到您的訂單查詢，我們正在為您處理。\n稍後會把結果傳送給您；若需人工請輸入【人工】。`,
              { ...debugBase, route:'order-ack' }
            );
          }

          if (!vendorReady()) {
            console.warn('VENDOR_NOT_READY(order)', { hasVendor: !!VENDOR_URL, hasSecret: !!LINE_SECRET });
            if (FORWARD_FALLBACK_ON_ERROR) {
              await pushToLine(
                userId,
                [{ type:'text', text:`尚未收到系統回覆，您可直接前往官網處理：\n${FALLBACK_URL}` }],
                { ...debugBase, route:'order-fallback-no-vendor' }
              );
            } else {
              const ans = await askOpenAI(userText);
              await pushToLine(userId, [{ type:'text', text: ans }], { ...debugBase, route:'order-ai-no-vendor' });
            }
            return res.status(200).send('OK');
          }

          const fwd = await forwardToVendorWebhook(raw);
          const parsed = parseVendorBody(fwd.body);
          console.log('FORWARD_VENDOR(order)', { ok: fwd.ok, status: fwd.status || '-', bodyLen: (fwd.body || '').length || 0, ack: !!VENDOR_ORDER_ACK });

          if (parsed && parsed.length) {
            await pushToLine(userId, parsed, { ...debugBase, route:'order-push' });
          } else {
            if (FORWARD_FALLBACK_ON_ERROR) {
              await pushToLine(
                userId,
                [{ type:'text', text:`尚未收到系統回覆，您可直接前往官網處理：\n${FALLBACK_URL}` }],
                { ...debugBase, route:'order-push-fallback' }
              );
            } else {
              const ans = await askOpenAI(userText);
              await pushToLine(userId, [{ type:'text', text: ans }], { ...debugBase, route:'order-ai-fallback' });
            }
          }
          return res.status(200).send('OK');
        }

        // Web Light：ACK → 轉外包 → 有內容就 push；無內容/太短→(依旗標)備援或AI
        if (isVendorIntent(userText)) {
          if (VENDOR_KW_ACK) {
            await replyToLine(
              replyToken,
              `已收到您的需求，我們正在處理中。\n稍後會由系統發送最新進度給您；若需人工請輸入【人工】。`,
              { ...debugBase, route:'vendor-ack' }
            );
          }

          if (!vendorReady()) {
            console.warn('VENDOR_NOT_READY(vendorKW)', { hasVendor: !!VENDOR_URL, hasSecret: !!LINE_SECRET });
            if (FORWARD_FALLBACK_ON_ERROR) {
              await pushToLine(
                userId,
                [{ type:'text', text:`尚未收到系統回覆，您可直接前往官網處理：\n${FALLBACK_URL}` }],
                { ...debugBase, route:'vendor-fallback-no-vendor' }
              );
            } else {
              const ans = await askOpenAI(userText);
              await pushToLine(userId, [{ type:'text', text: ans }], { ...debugBase, route:'vendor-ai-no-vendor' });
            }
            return res.status(200).send('OK');
          }

          const fwd = await forwardToVendorWebhook(raw);
          const parsed = parseVendorBody(fwd.body);
          console.log('FORWARD_VENDOR(vendorKW)', { ok: fwd.ok, status: fwd.status || '-', bodyLen: (fwd.body || '').length || 0, ack: !!VENDOR_KW_ACK });

          if (parsed && parsed.length) {
            await pushToLine(userId, parsed, { ...debugBase, route:'vendor-push' });
          } else {
            if (FORWARD_FALLBACK_ON_ERROR) {
              await pushToLine(
                userId,
                [{ type:'text', text:`尚未收到系統回覆，您可直接前往官網處理：\n${FALLBACK_URL}` }],
                { ...debugBase, route:'vendor-push-fallback' }
              );
            } else {
              const ans = await askOpenAI(userText);
              await pushToLine(userId, [{ type:'text', text: ans }], { ...debugBase, route:'vendor-ai-fallback' });
            }
          }
          return res.status(200).send('OK');
        }

        // 其他 → AI
        const ans = await askOpenAI(userText);
        await replyToLine(replyToken, ans, { ...debugBase, route:'ai' });
        return res.status(200).send('OK');
      }

      // 非文字訊息
      if (ev.type === 'message') {
        await replyToLine(
          ev.replyToken,
          `目前僅支援文字訊息喔。\n請以文字描述需求（例：「保固申請」「安裝教學」「查訂單 12345」）；若需附檔，亦可寄至【${SUPPORT_EMAIL}】。`,
          { route:'non-text', userIdTail: (ev.source?.userId || '').slice(-6) }
        );
        return res.status(200).send('OK');
      }

      // 加好友（follow）
      if (ev.type === 'follow') {
        const msg1 = { type:'text', text:
`歡迎加入【亦啟科技｜VicGether Tech.｜POWAH】官方帳號！🎉
這裡會不定期分享你不想錯過的【最新消息】與【小技巧】。
想開始：
- 查配送/進度 → 輸入【查訂單】（附【訂單編號】或【電話後四碼】更快）
- 產品諮詢/安裝相容 → 輸入【產品諮詢】
- 要真人協助 → 輸入【人工】
- 綁定會員 → 輸入【綁定會員】（或點下方按鈕）
需要附檔或詳述，也可寄至【${SUPPORT_EMAIL}】。
請問還有什麼地方需要我幫忙的嗎？` };
        const msg2 = {
          type:'text',
          text:'可以用下方快速按鈕開始：',
          quickReply:{ items:[
            { type:'action', action:{ type:'message', label:'查訂單',   text:'查訂單' } },
            { type:'action', action:{ type:'message', label:'產品諮詢', text:'產品諮詢' } },
            { type:'action', action:{ type:'message', label:'我要人工', text:'我要人工' } },
            { type:'action', action:{ type:'message', label:'綁定會員', text:'綁定會員' } }
          ]}
        };
        await replyMessages(ev.replyToken, [msg1, msg2], { route:'follow' });
        return res.status(200).send('OK');
      }
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error('WEBHOOK_ERR', e?.message || e);
    return res.status(200).send('OK');
  }
}
