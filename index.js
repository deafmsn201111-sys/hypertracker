import http from "node:http";
import {
  renderDashboard,
  groupFills,
  fillMessage,
  fillLine,
  diffOrders,
  describeOrder,
  esc,
} from "./format.js";

const env = process.env;
const BOT_TOKEN = env.BOT_TOKEN;
const USER = (env.HL_ADDRESS || "").toLowerCase();
const CHAT_ID = env.TG_CHAT_ID || "";
const POLL_SEC = Math.max(5, +env.POLL_SEC || 15);
const LIQ_ALERT_PCT = +env.LIQ_ALERT_PCT || 10;
const NOTIFY_ORDERS = env.NOTIFY_ORDERS !== "0";
const TZ = env.TIMEZONE || "UTC";

if (!BOT_TOKEN || !/^0x[\da-f]{40}$/.test(USER)) {
  console.error("Нужны переменные BOT_TOKEN и HL_ADDRESS (0x… адрес из 42 символов)");
  process.exit(1);
}

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const HL = "https://api.hyperliquid.xyz/info";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

// ---------- API ----------
async function hl(body) {
  const r = await fetch(HL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
  return r.json();
}

async function tg(method, params = {}) {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return r.json();
}

async function send(text) {
  if (!CHAT_ID) return null;
  const r = await tg("sendMessage", {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  if (!r.ok) console.error("sendMessage:", r.description);
  return r.ok ? r.result : null;
}

// ---------- Живое сообщение (редактируется на месте, без уведомлений) ----------
const dash = { messageId: null, text: "" };

async function updateDashboard(text) {
  if (!CHAT_ID) return;
  if (dash.messageId) {
    if (text === dash.text) return;
    const r = await tg("editMessageText", {
      chat_id: CHAT_ID,
      message_id: dash.messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    if (r.ok) {
      dash.text = text;
      return;
    }
    if (/not modified/i.test(r.description || "")) return;
    dash.messageId = null; // сообщение удалено или недоступно — отправим новое
  }
  const msg = await send(text);
  if (msg) {
    dash.messageId = msg.message_id;
    dash.text = text;
    tg("pinChatMessage", {
      chat_id: CHAT_ID,
      message_id: msg.message_id,
      disable_notification: true,
    }).catch(() => {});
  }
}

// ---------- Трекинг ----------
let latest = null;
let seeded = false;
const seenFills = new Set();
let prevOrders = new Map();
const liqAlerted = new Set();
let lastOk = Date.now(); // время последнего успешного цикла (для /health)

async function checkLiquidation(state) {
  for (const { position: p } of state.assetPositions) {
    if (+p.szi === 0 || p.liquidationPx == null) {
      liqAlerted.delete(p.coin);
      continue;
    }
    const mark = Math.abs(+p.positionValue / +p.szi);
    const dist = (Math.abs(mark - +p.liquidationPx) / mark) * 100;
    if (dist <= LIQ_ALERT_PCT) {
      if (!liqAlerted.has(p.coin)) {
        liqAlerted.add(p.coin);
        await send(
          `⚠️ <b>${esc(p.coin)}</b>: до ликвидации ${dist.toFixed(1)}%\n` +
            `Mark ${+mark.toPrecision(6)} · Ликвидация ${+(+p.liquidationPx).toPrecision(6)}`
        );
      }
    } else if (dist > LIQ_ALERT_PCT * 1.2) {
      liqAlerted.delete(p.coin);
    }
  }
}

async function tick() {
  const [state, orders, fills] = await Promise.all([
    hl({ type: "clearinghouseState", user: USER }),
    hl({ type: "frontendOpenOrders", user: USER }),
    hl({ type: "userFills", user: USER }),
  ]);
  latest = { state, orders, fills };

  const fresh = fills.filter((f) => !seenFills.has(f.tid));
  fills.forEach((f) => seenFills.add(f.tid));

  if (!seeded) {
    // первый запуск: запоминаем текущее состояние, чтобы не слать старые события
    seeded = true;
    prevOrders = new Map(orders.map((o) => [o.oid, o]));
    await send(`✅ Трекинг запущен, обновление каждые ${POLL_SEC} с.\nКоманды: /status, /fills`);
  } else {
    for (const g of groupFills(fresh).sort((a, b) => a.time - b.time)) {
      await send(fillMessage(g));
    }
    if (NOTIFY_ORDERS) {
      const { added, removed } = diffOrders(prevOrders, orders);
      if (added.length || removed.length) {
        const lines = ["📝 <b>Ордера изменились</b>"];
        added.forEach((o) => lines.push("➕ " + esc(describeOrder(o))));
        removed.forEach((o) => lines.push("➖ " + esc(describeOrder(o)) + " (снят или исполнен)"));
        await send(lines.join("\n"));
      }
    }
    prevOrders = new Map(orders.map((o) => [o.oid, o]));
  }

  await checkLiquidation(state);
  await updateDashboard(renderDashboard(latest, USER, TZ));
  lastOk = Date.now();
}

async function trackLoop() {
  while (true) {
    try {
      await tick();
    } catch (e) {
      console.error("tick:", e.message);
    }
    await sleep(POLL_SEC * 1000);
  }
}

// ---------- Команды Telegram (long polling) ----------
async function onMessage(msg) {
  const cmd = (msg.text || "").trim().split(/[\s@]/)[0].toLowerCase();

  if (!CHAT_ID) {
    if (cmd === "/start") {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: `Твой chat id: ${msg.chat.id}\nДобавь его в переменную TG_CHAT_ID и перезапусти сервис.`,
      });
    }
    return;
  }
  if (String(msg.chat.id) !== String(CHAT_ID)) return; // чужим не отвечаем

  if (cmd === "/status") {
    if (!latest) return void (await send("Данные ещё загружаются…"));
    await send(renderDashboard(latest, USER, TZ));
  } else if (cmd === "/fills") {
    if (!latest) return void (await send("Данные ещё загружаются…"));
    const recent = groupFills(latest.fills.slice(-60))
      .sort((a, b) => b.time - a.time)
      .slice(0, 10);
    await send(
      recent.length
        ? "<b>Последние сделки</b>\n" + recent.map((x) => fillLine(x, TZ)).join("\n")
        : "Сделок пока нет"
    );
  } else if (cmd === "/start" || cmd === "/help") {
    await send(
      "Живой дашборд закреплён и обновляется сам.\n/status — свежий снимок\n/fills — последние сделки"
    );
  }
}

async function telegramLoop() {
  let offset = 0;
  while (true) {
    try {
      const r = await tg("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"],
      });
      if (!r.ok) {
        console.error("getUpdates:", r.description);
        await sleep(5000);
        continue;
      }
      for (const u of r.result) {
        offset = u.update_id + 1;
        if (u.message?.text) await onMessage(u.message).catch((e) => console.error(e));
      }
    } catch (e) {
      console.error("telegramLoop:", e.message);
      await sleep(3000);
    }
  }
}

// ---------- Старт ----------
// Render ждёт открытый порт у Web Service. Этот же адрес пингует аптайм-робот:
// 200 — трекинг жив, 503 — цикл не обновлялся дольше порога (бот завис или API недоступен)
http
  .createServer((_, res) => {
    const age = (Date.now() - lastOk) / 1000;
    const ok = age < Math.max(90, POLL_SEC * 4);
    res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok, lastUpdateSecAgo: Math.round(age) }));
  })
  .listen(+env.PORT || 10000);

await tg("deleteWebhook").catch(() => {});
await tg("setMyCommands", {
  commands: [
    { command: "status", description: "Текущие позиции" },
    { command: "fills", description: "Последние сделки" },
  ],
}).catch(() => {});

trackLoop();
telegramLoop();
