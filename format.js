// Чистые функции: форматирование сообщений и сравнение состояний (без сети).

export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const money = (n) =>
  Math.abs(Number(n)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const px = (n) => (n == null ? "—" : String(+(+n).toPrecision(6)));
export const usd = (n) => "$" + money(n);
export const signed = (n) => (Number(n) >= 0 ? "+" : "−") + "$" + money(n);
export const pct = (n, d = 2) => {
  const v = Number(n) * 100;
  return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d) + "%";
};
export const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

export const fmtTime = (ms, tz = "UTC") =>
  new Date(ms).toLocaleString("ru-RU", {
    timeZone: tz,
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

// Типы триггерных ордеров: "Stop Market", "Stop Limit", "Take Profit Market", "Take Profit Limit"
export const isSL = (o) => o.isTrigger && /^Stop/.test(o.orderType);
export const isTP = (o) => o.isTrigger && /^Take Profit/.test(o.orderType);

export function describeOrder(o) {
  if (o.isTrigger) {
    const kind = isSL(o) ? "SL" : isTP(o) ? "TP" : o.orderType;
    const size = o.isPositionTpsl || +o.sz === 0 ? "вся позиция" : o.sz;
    const lim = /Limit$/.test(o.orderType) ? `, лимит ${px(o.limitPx)}` : "";
    return `${kind} ${o.coin}: триггер ${px(o.triggerPx)}${lim} (${size})`;
  }
  const side = o.side === "B" ? "Buy" : "Sell";
  const ro = o.reduceOnly ? " reduce-only" : "";
  return `${o.orderType} ${side} ${o.coin}: ${o.sz} @ ${px(o.limitPx)}${ro}`;
}

// Живой дашборд: позиции, PnL, вход, маржа, плечо, ликвидация, SL/TP
export function renderDashboard({ state, orders }, user, tz = "UTC") {
  const m = state.marginSummary;
  const positions = state.assetPositions
    .map((a) => a.position)
    .filter((p) => +p.szi !== 0);

  const out = [];
  out.push(`<b>📊 Hyperliquid</b> · <code>${short(user)}</code>`);
  out.push(`Equity: <b>${usd(m.accountValue)}</b>`);
  out.push(
    `Маржа занята: ${usd(m.totalMarginUsed)} · Доступно: ${usd(state.withdrawable)}`
  );
  out.push(`Объём позиций: ${usd(m.totalNtlPos)}`);

  if (!positions.length) out.push("\nОткрытых позиций нет");

  for (const p of positions) {
    const size = +p.szi;
    const long = size > 0;
    const mark = Math.abs(+p.positionValue / size);
    const liq = p.liquidationPx != null ? +p.liquidationPx : null;
    const dist = liq != null ? (Math.abs(mark - liq) / mark) * 100 : null;
    const sl = orders.filter((o) => o.coin === p.coin && isSL(o));
    const tp = orders.filter((o) => o.coin === p.coin && isTP(o));

    out.push("");
    out.push(
      `${long ? "🟢 LONG" : "🔴 SHORT"} <b>${esc(p.coin)}</b> · ${p.leverage.value}x ${p.leverage.type}`
    );
    out.push(
      `Размер: ${Math.abs(size)} (${usd(p.positionValue)}) · Маржа: ${usd(p.marginUsed)}`
    );
    out.push(`Вход: ${px(p.entryPx)} · Mark: ${px(mark)}`);
    out.push(
      `PnL: <b>${signed(p.unrealizedPnl)}</b> (ROE ${pct(p.returnOnEquity)})`
    );
    out.push(
      `Ликвидация: ${liq != null ? `${px(liq)} (${dist.toFixed(1)}% от mark)` : "—"}`
    );
    out.push(
      `SL: ${sl.length ? sl.map((o) => px(o.triggerPx)).join(", ") : "—"} · TP: ${
        tp.length ? tp.map((o) => px(o.triggerPx)).join(", ") : "—"
      }`
    );
  }

  const posCoins = new Set(positions.map((p) => p.coin));
  const rest = orders.filter((o) => !(posCoins.has(o.coin) && (isSL(o) || isTP(o))));
  if (rest.length) {
    out.push("\n<b>Прочие ордера</b>");
    rest.slice(0, 15).forEach((o) => out.push("• " + esc(describeOrder(o))));
    if (rest.length > 15) out.push(`… и ещё ${rest.length - 15}`);
  }

  out.push(
    `\n🕒 ${new Date().toLocaleTimeString("ru-RU", { timeZone: tz, hour12: false })}`
  );
  return out.join("\n");
}

// Склеиваем частичные исполнения одного ордера в одну запись
export function groupFills(fills) {
  const g = new Map();
  for (const f of fills) {
    const k = `${f.oid}|${f.dir}`;
    const x = g.get(k) ?? {
      coin: f.coin,
      dir: f.dir,
      sz: 0,
      notional: 0,
      pnl: 0,
      fee: 0,
      liq: false,
      time: 0,
    };
    x.sz += +f.sz;
    x.notional += +f.sz * +f.px;
    x.pnl += +f.closedPnl || 0;
    x.fee += +f.fee || 0;
    x.liq = x.liq || !!f.liquidation;
    x.time = Math.max(x.time, f.time);
    g.set(k, x);
  }
  return [...g.values()].map((x) => ({ ...x, px: x.notional / x.sz }));
}

export function fillMessage(x) {
  const open = /^Open/.test(x.dir);
  const icon = x.liq ? "🚨" : open ? "🔔" : "✅";
  const lines = [
    `${icon} <b>${esc(x.dir)} ${esc(x.coin)}</b>${x.liq ? " — ЛИКВИДАЦИЯ" : ""}`,
    `Размер: ${+x.sz.toFixed(6)} @ ${px(x.px)} (${usd(x.notional)})`,
  ];
  if (x.pnl !== 0 || /Close|>/.test(x.dir))
    lines.push(`Реализованный PnL: <b>${signed(x.pnl)}</b>`);
  lines.push(`Комиссия: ${usd(x.fee)}`);
  return lines.join("\n");
}

export function fillLine(x, tz) {
  const pnl = x.pnl !== 0 ? ` · ${signed(x.pnl)}` : "";
  return `${fmtTime(x.time, tz)} · ${esc(x.dir)} ${esc(x.coin)} ${+x.sz.toFixed(6)} @ ${px(x.px)}${pnl}`;
}

// prev: Map(oid -> order), cur: массив ордеров
export function diffOrders(prev, cur) {
  const curIds = new Set(cur.map((o) => o.oid));
  return {
    added: cur.filter((o) => !prev.has(o.oid)),
    removed: [...prev.values()].filter((o) => !curIds.has(o.oid)),
  };
}
