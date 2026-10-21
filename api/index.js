// Vercel Serverless implementation of the Monitor demo API.
// Mirrors the Spring Boot `demo` profile (DemoStore) contract used by the frontend:
// envelope { code, message, request_id, server_time, data }, snake_case fields,
// amounts in fen, ratios in 0-1. The Java backend remains the production path
// (K8s); this function lets the prototype run standalone on Vercel.

const TOKENS = {
  "dash-token": { role: "DASH_READ", scopes: ["agg", "dict"] },
  "cs-token": { role: "CS_DETAIL", scopes: ["ods", "dict"] },
  "oncall-token": { role: "ALERT_OPS", scopes: ["agg", "dict", "alert"] },
  "ingest-token": { role: "INGEST", scopes: ["ingest"] },
  "admin-token": { role: "ADMIN", scopes: ["agg", "ods", "dict", "alert", "ingest", "admin"] },
};
const ROLE_TOKENS = { dash: "dash-token", cs: "cs-token", oncall: "oncall-token", ingest: "ingest-token", admin: "admin-token" };

const BIZ = {
  driver: { label: "司机端", color: "#3587e7", orders: 286412, delivered: 261883, gtv_fen: 384200000, delta: 0.042, rate_good: true, scale: 0.513 },
  transfer: { label: "转单端", color: "#e0923f", orders: 42180, delivered: 34526, gtv_fen: 58600000, delta: -0.021, rate_good: false, scale: 0.076 },
  carpool: { label: "顺风车", color: "#25a579", orders: 128463, delivered: 53136, gtv_fen: 48600000, delta: 0.084, rate_good: true, scale: 0.23 },
  designated: { label: "代驾", color: "#c56ad0", orders: 68924, delivered: 62748, gtv_fen: 92400000, delta: 0.038, rate_good: true, scale: 0.124 },
  airport: { label: "接送机", color: "#dc5a58", orders: 31886, delivered: 28414, gtv_fen: 71200000, delta: 0.016, rate_good: true, scale: 0.057 },
};
const bizScale = (biz) => (!biz || biz === "all" ? 1 : BIZ[biz]?.scale ?? 1);

const CITIES = [
  { city_id: 330100, name: "杭州", delivered: 38642, delivery_rate: 0.872, gtv_fen: 41200000, yoy: 0.038, firing_alerts: 1, priority: "focus" },
  { city_id: 440100, name: "广州", delivered: 34906, delivery_rate: 0.845, gtv_fen: 38600000, yoy: -0.012, firing_alerts: 2, priority: "focus" },
  { city_id: 510100, name: "成都", delivered: 31188, delivery_rate: 0.866, gtv_fen: 34100000, yoy: 0.051, firing_alerts: 1, priority: "focus" },
  { city_id: 310000, name: "上海", delivered: 28951, delivery_rate: 0.891, gtv_fen: 37200000, yoy: 0.022, firing_alerts: 0, priority: "focus" },
  { city_id: 320100, name: "南京", delivered: 22832, delivery_rate: 0.858, gtv_fen: 24600000, yoy: 0.017, firing_alerts: 0, priority: "normal" },
  { city_id: 440300, name: "深圳", delivered: 21640, delivery_rate: 0.884, gtv_fen: 26800000, yoy: 0.009, firing_alerts: 0, priority: "focus" },
];

const acked = globalThis.__monitorAcked ?? (globalThis.__monitorAcked = new Map());

function alertSeed(now) {
  const m = (min) => new Date(now.getTime() - min * 60000).toISOString();
  const rows = [
    [4471, "R02", "P0", "预付成功率持续低于阈值", "carpool", 0, "全国", "全国 · 全部座型", 4, 3, 0.918, 0.95, "threshold", -3.2, 9420, 10261, "fund.prepay_success_rate", "v3", "firing"],
    [4472, "R05", "P0", "派单响应超时激增", "driver", 0, "全国", "全国 · 快车", 3, 3, 0.124, 0.05, "threshold", 7.4, 10664, 86000, "driver.dispatch_timeout_rate", "v2", "firing"],
    [4473, "R10", "P1", "完单率低于 30 日基线", "carpool", 330100, "杭州", "杭州市 · 独享", 12, 2, 0.724, 0.831, "baseline30d", -10.7, 5021, 6935, "core.delivery_rate", "v2", "firing"],
    [4474, "R04", "P1", "转单成功率下降", "transfer", 440100, "广州", "广州市", 9, 3, 0.682, 0.82, "baseline30d", -13.8, 2380, 3490, "transfer.transfer_success_rate", "v1", "firing"],
    [4475, "R13", "P1", "结算逾期单量超阈值", "carpool", 440100, "广州", "广州市 · 全部座型", 12, 2, 68, 50, "threshold", 36.0, 68, 0, "fund.settle_overdue_cnt", "v1", "claimed"],
    [4476, "R06", "P1", "代驾接单超时", "designated", 510100, "成都", "成都市", 8, 2, 0.186, 0.1, "threshold", 8.6, 2264, 12172, "designated.accept_timeout_rate", "v1", "firing"],
    [4477, "R19", "P2", "上车等待超率偏高", "carpool", 510100, "成都", "成都市 · 2座", 19, 2, 0.173, 0.15, "threshold", 2.3, 1210, 6994, "core.wait_over8_rate", "v1", "firing"],
    [4478, "R16", "P2", "航班延误取消量上升", "airport", 110000, "北京", "首都 T3", 25, 2, 47, 28, "yoy", 67.9, 47, 0, "core.order_cancelled_cnt", "v2", "claimed"],
    [4479, "R09", "P0", "支付回调接口失败率越界", "all", 0, "全国", "支付中心 · 全平台", 3, 3, 0.047, 0.02, "threshold", 2.7, 6032, 128340, "api.fail_rate", "v1", "firing"],
    [4480, "R21", "P1", "航班状态同步接口异常率上升", "airport", 0, "全国", "接送机 · flight-service", 14, 2, 0.009, 0.005, "threshold", 0.4, 65, 7200, "api.dependency_error_rate", "v1", "firing"],
  ];
  return rows.map(([alert_id, rule_id, level, title, biz_line, city_id, city_name, text, mins, periods, value, baseline, baseline_kind, delta_pp, numerator, denominator, metricId, version, status]) => {
    const ack = acked.get(alert_id);
    return {
      alert_id, rule_id, level, title, biz_line,
      scope: { city_id, city_name, seat_type: "all", text },
      fired_at: m(mins), duration_sec: mins * 60, periods, value, baseline, baseline_kind, delta_pp,
      sample: { numerator, denominator },
      status: ack ? "claimed" : status,
      ack_by: ack?.user ?? (status === "claimed" ? "linzhou" : null),
      ack_at: ack?.at ?? null,
      metric: { id: metricId, version, dict_url: `/dict/${metricId}` },
      links: { drilldown: `/api/v1/alerts/${alert_id}/drilldown`, runbook: `https://wiki.internal/rb/${rule_id.toLowerCase()}`, notify_channels: level === "P0" ? ["im_strong", "sms"] : ["im_at"] },
      noise: { deduped: level === "P0" ? 3 : 0, aggregated_cities: city_id === 0 ? 12 : 1, suppressed_by: null },
    };
  });
}

const counter = (metric, label, value, delta, unit = "count", version = "v1") => ({
  metric, version, label, value, unit, delta: delta ?? null, delta_dir: delta == null ? null : delta >= 0 ? "up" : "down",
  good: delta == null ? true : delta >= 0, partial: true,
});
const ratio = (metric, label, numerator, denominator, delta_pp, good, version = "v1") => ({
  metric, version, label, value: denominator ? Math.round((numerator / denominator) * 10000) / 10000 : 0, unit: "ratio",
  numerator, denominator, delta_pp: delta_pp ?? null, delta_dir: delta_pp == null ? null : delta_pp >= 0 ? "up" : "down",
  good: good ?? (delta_pp == null ? true : delta_pp >= 0), compare_note: "较昨日", partial: true, sample: denominator,
});

function kpiFor(biz) {
  const s = bizScale(biz);
  const orders = Math.round(557865 * s), delivered = Math.round(440707 * s);
  return [
    counter("core.order_created_cnt", "创建订单数", orders, 0.056),
    counter("core.order_delivered_cnt", "送达完单数", delivered, 0.031),
    ratio("core.delivery_rate", "完单率", delivered, Math.round(499667 * s), -1.2, false, "v2"),
    { ...counter("fund.gtv_net", "净 GTV", Math.round(6550000000 * s), 0.047, "fen", "v3") },
    ratio("fund.settle_delay_rate", "结算延迟率", Math.round(1852 * s), Math.round(440752 * s), 0.18, false),
  ];
}

function linkHealth(now) {
  const nodes = [
    { key: "mq", label: "业务事件 MQ", status: "ok", detail: "lag 1.2s", metric: "link.consumer_lag", metrics: { lag_sec: 1.2 }, since: now.toISOString() },
    { key: "consumer", label: "Consumer", status: "ok", detail: "4 / 4 实例", metric: "link.consumer_lag", metrics: { instances: 4 }, since: now.toISOString() },
    { key: "clickhouse", label: "ClickHouse", status: "ok", detail: "2 / 2 副本", metrics: { write_latency_ms: 42, replica_lag_sec: 0.3 }, since: now.toISOString() },
    { key: "freshness", label: "事件新鲜度", status: "bad", detail: "P99 6m12s", metric: "link.ingest_delay_p99", alert_id: 4471, metrics: { p99_sec: 372 }, since: now.toISOString() },
    { key: "evaluator", label: "规则求值", status: "ok", detail: "最近求值完成", metrics: { rules: 20 }, since: now.toISOString() },
  ];
  return { evaluated_at: now.toISOString(), window_delay_sec: 60, abnormal: 1, blind: false, silenced_by_backfill: false, nodes, note: "链路失明本身是 P0 规则，不会把断流误读为业务正常" };
}

const APIS = [
  { api_id: "pay.callback", path: "/api/v1/pay/callback", service: "pay-service", service_label: "支付回调", biz_line: "all", qps: 2140, fail_rate: 0.047, p50_ms: 180, p99_ms: 640, status: "bad", trend: [0.31, 0.29, 0.38, 0.52, 1.24, 3.16, 4.7], err_top: [{ code: "PAY_CHANNEL_TIMEOUT", share: 0.62 }, { code: "WALLET_LOCK_BUSY", share: 0.18 }], upstream: "order-service", downstream: [], linked_rule: "R09", linked_alert_id: 4479 },
  { api_id: "dispatch.respond", path: "/api/v1/dispatch/respond", service: "dispatch-service", service_label: "派单响应", biz_line: "driver", qps: 860, fail_rate: 0.0231, p50_ms: 210, p99_ms: 890, status: "bad", trend: [0.42, 0.55, 0.61, 0.88, 1.42, 2.05, 2.31], err_top: [], upstream: "order-service", downstream: [], linked_rule: null, linked_alert_id: null },
  { api_id: "transfer.submit", path: "/api/v1/transfer/submit", service: "transfer-service", service_label: "转单提交", biz_line: "transfer", qps: 340, fail_rate: 0.0162, p50_ms: 130, p99_ms: 420, status: "warn", trend: [0.22, 0.31, 0.28, 0.36, 0.74, 1.38, 1.62], err_top: [], upstream: "order-service", downstream: [] },
  { api_id: "flight.sync", path: "/api/v1/flight/sync", service: "flight-service", service_label: "航班状态同步", biz_line: "airport", qps: 120, fail_rate: 0.009, p50_ms: 640, p99_ms: 1800, status: "warn", trend: [0.1, 0.14, 0.18, 0.31, 0.52, 0.74, 0.9], err_top: [], upstream: "order-service", downstream: [] },
  { api_id: "order.create", path: "/api/v1/order/create", service: "order-service", service_label: "创建订单", biz_line: "driver", qps: 1240, fail_rate: 0.0034, p50_ms: 88, p99_ms: 240, status: "ok", trend: [0.08, 0.06, 0.09, 0.11, 0.14, 0.29, 0.34], err_top: [], upstream: "order-service", downstream: [] },
  { api_id: "withdraw.apply", path: "/api/v1/withdraw/apply", service: "withdraw-service", service_label: "提现申请", biz_line: "carpool", qps: 280, fail_rate: 0.0012, p50_ms: 96, p99_ms: 320, status: "ok", trend: [], err_top: [], upstream: "order-service", downstream: [] },
  { api_id: "settle.credit", path: "/api/v1/settle/credit", service: "settle-service", service_label: "结算入账", biz_line: "carpool", qps: 620, fail_rate: 0.0008, p50_ms: 74, p99_ms: 210, status: "ok", trend: [], err_top: [], upstream: "order-service", downstream: [] },
  { api_id: "risk.evaluate", path: "/api/v1/risk/evaluate", service: "risk-engine", service_label: "规则判定", biz_line: "all", qps: 3200, fail_rate: 0.0001, p50_ms: 12, p99_ms: 45, status: "ok", trend: [], err_top: [], upstream: "order-service", downstream: [] },
];

const ORDER_ID = "CP20260903018462";
function orderTimeline(now) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now); // YYYY-MM-DD
  const at = (t) => `${day}T${t}+08:00`;
  const raw = [
    ["prepay_succeeded", "乘客预付成功", "¥86.50 · 杭州市", 8650, "09:12:08"],
    ["order_pool_entered", "进入推荐池", "独享 · 预计 2 人", 0, "09:13:41"],
    ["order_grab_submitted", "司机提交抢单", "候选司机 8", 0, "09:16:20"],
    ["order_grab_won", "司机抢单成功", "耗时 2.1s", 0, "09:16:22"],
    ["passenger_confirmed", "乘客确认同行", "手动确认", 0, "09:18:04"],
    ["passenger_boarded", "乘客已上车", "等待 4m 21s", 0, "10:02:19"],
    ["order_delivered", "订单送达", "履约 75m 33s", 0, "11:17:52"],
    ["settlement_credited", "结算已入账", "司机收入 ¥72.40", 7240, "11:18:14"],
  ];
  let prev = null;
  const events = raw.map(([event_type, label, note, amount_fen, t], i) => {
    const time = new Date(at(t));
    const gap = prev ? Math.round((time - prev) / 1000) : null;
    prev = time;
    return { seq: i + 1, event_time: time.toISOString(), event_type, label, note, amount_fen, props: {}, gap_from_prev_sec: gap, abnormal: false };
  });
  return { order_id: ORDER_ID, duration_sec: 7566, started_at: events[0].event_time, ended_at: events.at(-1).event_time, query_cost_ms: 12, events, missing: [] };
}
const ORDER = {
  order_id: ORDER_ID, biz_line: "carpool", status: "completed", status_label: "已完成", city_id: 330100, city_name: "杭州",
  seat_type: "exclusive", amount_fen: 8650, driver_id_hash_masked: "8a7f...21de", trip_id: "T8842017763", dt: "2026-09-03",
  event_count: 8, completeness: { state: "complete", expected_nodes: 8, present_nodes: 8, missing: [] }, risk_flags: [],
  privacy_note: "仅展示脱敏后的维度快照；原始标识和非白名单属性不返回",
};

function auth(req, url, scope) {
  const header = req.headers.authorization || "";
  let token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token && url.searchParams.get("_monitor_role")) token = ROLE_TOKENS[url.searchParams.get("_monitor_role")];
  const principal = token ? TOKENS[token] : null;
  if (!principal) return { error: [401, 40101, "缺少或无效的 Authorization token"] };
  if (scope && !principal.scopes.includes(scope)) return { error: [403, 40301, `当前角色 ${principal.role} 无 ${scope} 访问权`] };
  return { principal };
}

export default function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.searchParams.get("__pathname") || url.pathname;
  url.searchParams.delete("__pathname");
  const now = new Date();
  const requestId = Math.random().toString(16).slice(2, 18);

  const send = (status, data, envelope = true) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Monitor-Dict-Version", "2026.09");
    res.setHeader("X-Monitor-Freshness", new Date(now.getTime() - 60000).toISOString());
    res.setHeader("X-Monitor-partial", "true");
    res.setHeader("X-Monitor-Grain", "1d");
    res.end(JSON.stringify(envelope ? { code: status === 200 ? 0 : data.code, message: data.message ?? "OK", request_id: requestId, server_time: now.toISOString(), data: data.data ?? data } : data));
  };
  const ok = (data) => send(200, { data });
  const fail = (status, code, message) => send(status, { code, message, data: null });

  try {
    if (pathname === "/actuator/health") {
      res.statusCode = 200; res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ status: "UP", groups: ["liveness", "readiness"] }));
    }
    if (!pathname.startsWith("/api/v1/")) return fail(404, 40401, "接口不存在");

    const path = pathname.slice("/api/v1".length);
    const biz = url.searchParams.get("biz_line") || "all";
    if (!["all", ...Object.keys(BIZ)].includes(biz)) return fail(400, 40001, `未知 biz_line: ${biz}`);
    const s = bizScale(biz);

    // scope routing
    let scope = "agg";
    if (path.startsWith("/orders")) scope = "ods";
    else if (/^\/alerts\/\d+\/ack/.test(path)) scope = "alert";
    else if (path.startsWith("/dict")) scope = "dict";
    const a = auth(req, url, scope);
    if (a.error) return fail(...a.error);

    const alerts = alertSeed(now);
    const filteredAlerts = alerts.filter((x) => biz === "all" || x.biz_line === biz || x.biz_line === "all");

    if (req.method === "GET" && path === "/sentinel/bootstrap") {
      const cards = Object.entries(BIZ).map(([id, b]) => ({
        biz_line: id, label: b.label, color: b.color, orders: b.orders, delivered: b.delivered,
        delivery_rate: Math.round((b.delivered / b.orders) * 10000) / 10000, gtv_fen: b.gtv_fen, delta: b.delta, rate_good: b.rate_good,
        top_alert: alerts.find((x) => x.biz_line === id) ? { title: alerts.find((x) => x.biz_line === id).title, level: alerts.find((x) => x.biz_line === id).level } : null,
      }));
      return ok({ link_health: linkHealth(now), kpi: kpiFor(biz), biz_cards: biz === "all" ? cards : [], alerts: filteredAlerts, alert_meta: { firing: filteredAlerts.filter((x) => x.status === "firing").length, claimed: filteredAlerts.filter((x) => x.status === "claimed").length } });
    }
    if (req.method === "GET" && path === "/overview/link-health") return ok(linkHealth(now));
    if (req.method === "GET" && path === "/overview/summary") {
      const ids = (url.searchParams.get("metrics") || "").split(",").filter(Boolean);
      const all = Object.fromEntries(kpiFor(biz).map((v) => [v.metric, v]));
      return ok(ids.map((id) => all[id]).filter(Boolean));
    }
    if (req.method === "GET" && path === "/overview/timeseries") {
      const shape = [0.86, 0.57, 0.48, 1.15, 4.07, 3.12, 2.62, 2.38, 3.25, 4.59, 3.72, 1.89];
      const mk = (metric, key, total, color) => ({ metric, key, color, points: shape.map((f, i) => ({ t: new Date(now.getTime() - (11 - i) * 7200000).toISOString(), value: Math.round((total * f) / 30), sample: Math.round((total * f) / 30), degraded: null })) });
      return ok({ grain: url.searchParams.get("grain") || "2h", partial: true, series: [mk("core.order_created_cnt", "order_created_cnt", 557865 * s, "#6558d3"), mk("core.order_delivered_cnt", "order_delivered_cnt", 440707 * s, "#3587e7")], annotations: [] });
    }
    if (req.method === "GET" && path === "/dashboard/funnel") {
      const eff = biz === "all" ? "carpool" : biz;
      const defs = {
        carpool: [["trip_published", "发布行程", 128463], ["grab_submitted", "提交抢单", 101826], ["grab_won", "抢单成功", 69241], ["confirmed", "确认同行", 61582], ["boarded", "上车", 56310], ["delivered", "送达完单", 53136]],
        driver: [["created", "乘客下单", 286412], ["dispatched", "系统派单", 272091], ["acked", "司机接单", 261220], ["arrived", "到达上车点", 255000], ["delivered", "送达完单", 261883]],
        transfer: [["created", "原单创建", 42180], ["submitted", "发起转单", 38642], ["accepted", "新司机接单", 34926], ["delivered", "送达完单", 34526]],
        designated: [["created", "乘客下单", 68924], ["assigned", "代驾接单", 65478], ["arrived", "到达代驾点", 63000], ["delivered", "送达完单", 62748]],
        airport: [["booked", "乘客预约", 31886], ["created", "司机接单", 30500], ["arrived", "到达接送点", 29000], ["delivered", "送达完单", 28414]],
      };
      const stepsRaw = defs[eff];
      const steps = stepsRaw.map(([key, label, value], i) => ({ key, label, value, rate: i === 0 ? null : Math.round((value / stepsRaw[i - 1][2]) * 10000) / 10000, numerator: i === 0 ? null : value, denominator: i === 0 ? null : stepsRaw[i - 1][2], prev_value: null, leak: null, leak_top_cities: null }));
      return ok({ biz_line: eff, definition_version: eff === "carpool" || eff === "driver" ? "v2" : "v1", rolling: eff === "carpool", note: eff === "carpool" ? "当天为滚动值，T+1 定盘" : "字典驱动漏斗", steps });
    }
    if (req.method === "GET" && path === "/dashboard/composition") {
      const metric = url.searchParams.get("metric") || "core.order_created_cnt";
      const items = Object.entries(BIZ).map(([id, b]) => ({ biz_line: id, label: b.label, value: metric === "core.order_delivered_cnt" ? b.delivered : metric === "fund.gtv_net" ? b.gtv_fen : b.orders, share: 0, color: b.color, delta: b.delta }));
      const total = items.reduce((t, x) => t + x.value, 0);
      items.forEach((x) => (x.share = total ? Math.round((x.value / total) * 10000) / 10000 : 0));
      return ok({ metric, total, items });
    }
    if (req.method === "GET" && path === "/dashboard/city-rank") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 10), 100);
      const sort = url.searchParams.get("sort") || "delivered_desc";
      const rows = CITIES.map((c) => ({ ...c, delivered: Math.round(c.delivered * s), gtv_fen: Math.round(c.gtv_fen * s) }));
      rows.sort((x, y) => (sort === "delivery_rate_asc" ? x.delivery_rate - y.delivery_rate : sort === "gtv_desc" ? y.gtv_fen - x.gtv_fen : y.delivered - x.delivered));
      return ok(rows.slice(0, limit));
    }
    if (req.method === "GET" && path === "/dashboard/heatmap") {
      const rows = CITIES.slice(0, 5).map((c, r) => ({ city_id: c.city_id, name: c.name, cells: Array.from({ length: 12 }, (_, col) => { const v = Math.round((0.36 + ((r * 3 + col * 5) % 8) / 14) * 10000) / 10000; return { hour: String(col * 2), value: v, intensity: v, sample: 2000 + col * 137, peak: col * 2 >= 7 && col * 2 <= 9 }; }) }));
      return ok({ hours: Array.from({ length: 12 }, (_, i) => String(i * 2).padStart(2, "0")), scale: { min: 0.36, max: 0.86, normalize: "per_row" }, rows });
    }
    if (req.method === "GET" && path === "/quality/summary") {
      const vals = [
        { ...ratio("core.cancel_rate_atfault", "服务方有责取消率", Math.round(3824 * s), Math.round(499667 * s), 0.3, false, "v2"), caliber: "无责取消不计入分子" },
        { ...ratio("core.no_show_rate", "爽约率", Math.round(3098 * s), Math.round(499667 * s), -0.08, true), caliber: "仅计信用分 -10 的事件" },
        { ...ratio("core.wait_over8_rate", "等待超时率", Math.round(56310 * s), Math.round(439921 * s), 1.6, false), caliber: "wait_sec > 480" },
        { ...ratio("exp.complaint_rate", "客诉率", Math.round(1675 * s), Math.round(440707 * s), -0.05, true), caliber: "按单口径，7日滚动" },
      ];
      return ok(vals.map((value) => ({ value, caliber: value.caliber })));
    }
    if (req.method === "GET" && path === "/quality/cancel-matrix") {
      const marginalRaw = [["service_at_fault", "司机/服务方有责", 3824, "#e45e5e"], ["service_no_fault", "司机/服务方无责", 5175, "#edae49"], ["passenger", "用户取消", 9398, "#6558d3"], ["system", "系统取消", 1286, "#9b9ca8"]];
      const total = marginalRaw.reduce((t, x) => t + x[2], 0);
      return ok({ totals: { cancel_cnt: Math.round(total * s), denominator: Math.round(499667 * s) }, marginal: marginalRaw.map(([key, label, value, color]) => ({ key, label, value: Math.round(value * s), share: Math.round((value / total) * 10000) / 10000, color })), full: [] });
    }
    if (req.method === "GET" && path === "/quality/risk-cities") {
      return ok([
        { city_id: 510100, name: "成都", score: 82, level: "high", main_metric: "core.wait_over8_rate", main_label: "等待超率", main_value: 0.173, suggested_action: "检查夜间运力与调度半径" },
        { city_id: 440100, name: "广州", score: 78, level: "high", main_metric: "exp.appeal_overturn_rate", main_label: "申诉推翻率", main_value: 0.328, suggested_action: "复核判责规则" },
        { city_id: 420100, name: "武汉", score: 61, level: "mid", main_metric: "exp.complaint_rate", main_label: "客诉率", main_value: 0.0053, suggested_action: "关注雨天派单半径" },
        { city_id: 330100, name: "杭州", score: 55, level: "mid", main_metric: "exp.review_bad_rate", main_label: "差评率", main_value: 0.0186, suggested_action: "低分段培训" },
      ]);
    }
    if (req.method === "GET" && path === "/orders/recent") {
      const limit = Number(url.searchParams.get("limit") || 8);
      if (limit < 1 || limit > 20) return fail(400, 40001, "limit 必须为 1-20");
      if (biz !== "all" && biz !== "carpool") return ok([]);
      return ok([{ order_id: ORDER_ID, biz_line: "carpool", city_id: 330100, city_name: "杭州", status: "completed", event_count: 8, updated_at: orderTimeline(now).ended_at }].slice(0, limit));
    }
    const orderMatch = path.match(/^\/orders\/([^/]+)(\/workbench|\/events|\/events\.ndjson)?$/);
    if (req.method === "GET" && orderMatch) {
      const id = decodeURIComponent(orderMatch[1]);
      if (id.toLowerCase() !== ORDER_ID.toLowerCase()) return fail(404, 40401, `订单 ${id} 未找到`);
      const timeline = orderTimeline(now);
      if (orderMatch[2] === "/events.ndjson") {
        res.statusCode = 200; res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Content-Disposition", `inline; filename=order-${ORDER_ID}-events.ndjson`);
        return res.end(timeline.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      }
      if (orderMatch[2] === "/workbench") return ok({ order: ORDER, timeline });
      if (orderMatch[2] === "/events") return ok(timeline);
      return ok(ORDER);
    }
    if (req.method === "GET" && path === "/risk/summary") {
      return ok([
        counter("risk.risk_hit_cnt", "风控规则命中数", Math.round(1493 * s), 0.086),
        { ...counter("risk.frozen_amount_sum", "冻结金额合计", Math.round(62800000 * s), 0.051, "fen") },
        ratio("exp.appeal_overturn_rate", "申诉推翻率", Math.round(164 * s), Math.round(892 * s), -2.2, true),
        counter("risk.intercepted_order_cnt", "拦截订单", Math.round(428 * s), 0.034),
      ]);
    }
    if (req.method === "GET" && path === "/risk/rules/timeseries") {
      const hits = [1342, 1286, 1518, 1442, 1380, 1628, 1493], frozen = [282, 271, 336, 305, 292, 377, 328];
      return ok({ series: [{ rule_id: "R-1142", name: "高频短单刷单", points: hits.map((hit, i) => ({ t: `2026-09-0${i + 1}`, hit, frozen_amount_fen: frozen[i] * 10000 })) }], spikes: [] });
    }
    if (req.method === "GET" && path === "/risk/top-entities") {
      return ok([
        { entity_id: "91ad...0fe2", biz_line: "carpool", short_orders: 18, hits: 12, rule_ids: ["R-1142"], risk_score: 92, level: "high", frozen_amount_fen: 12400000 },
        { entity_id: "4bc2...821a", biz_line: "driver", short_orders: 15, hits: 9, rule_ids: ["R-1142", "R-2201"], risk_score: 87, level: "high", frozen_amount_fen: 9840000 },
        { entity_id: "72ef...d191", biz_line: "carpool", short_orders: 12, hits: 7, rule_ids: ["R-2201"], risk_score: 64, level: "mid", frozen_amount_fen: 7620000 },
        { entity_id: "0a84...31dd", biz_line: "designated", short_orders: 11, hits: 6, rule_ids: ["R-3310"], risk_score: 58, level: "mid", frozen_amount_fen: 6180000 },
      ]);
    }
    if (req.method === "GET" && path === "/tech/summary") {
      const rows = APIS.filter((x) => biz === "all" || x.biz_line === biz || x.biz_line === "all");
      const abnormal = rows.filter((x) => x.status === "bad").length;
      const avg = rows.length ? rows.reduce((t, x) => t + x.fail_rate, 0) / rows.length : 0;
      return ok([
        { metric: "api.monitored_cnt", label: "监控核心接口", value: rows.length, unit: "count", delta: 2, good: true },
        { metric: "api.abnormal_cnt", label: "当前异常接口", value: abnormal, unit: "count", delta: 2, good: false },
        { metric: "api.avg_fail_rate", label: "平均失败率", value: Math.round(avg * 10000) / 10000, unit: "ratio", delta_pp: 0.11, good: false },
        { metric: "api.ingress_qps", label: "上游入口 QPS", value: rows.reduce((t, x) => t + x.qps, 0), unit: "count", delta: 0.064, good: true },
        { metric: "api.link_p99_ms", label: "链路 P99 延迟", value: Math.max(0, ...rows.map((x) => x.p99_ms)), unit: "ms", delta: 120, good: false },
      ]);
    }
    if (req.method === "GET" && path === "/tech/apis") {
      const rows = APIS.filter((x) => biz === "all" || x.biz_line === biz || x.biz_line === "all").map((x) => ({ ...x, fail_rate_threshold: { warn: 0.005, bad: 0.02 } }));
      const sort = url.searchParams.get("sort");
      rows.sort((x, y) => (sort === "p99_desc" ? y.p99_ms - x.p99_ms : sort === "qps_desc" ? y.qps - x.qps : y.fail_rate - x.fail_rate));
      return ok(rows);
    }
    if (req.method === "GET" && path === "/tech/topology") {
      const node = (id, label, sub, x, y, w, h, kind) => ({ id, label, sub, x, y, w, h, alerted: ["pay", "dispatch"].includes(id), kind });
      return ok({
        window: "5m", generated_at: now.toISOString(),
        nodes: [node("client", "客户端 App", "5 条业务线", 20, 182, 110, 40, "edge"), node("gw", "API 网关", "8,420 QPS", 200, 182, 110, 40, "gateway"), node("order", "订单中心", "6,180 QPS", 380, 182, 110, 40, "core"), node("pay", "支付中心", "2,140 QPS", 680, 34, 150, 40, "core"), node("dispatch", "调度派单", "860 QPS", 680, 118, 150, 40, "core"), node("settle", "结算中心", "620 QPS", 680, 202, 150, 40, "core"), node("risk", "风控引擎", "3,200 QPS", 680, 286, 150, 40, "core"), node("notify", "消息通知", "1,050 QPS", 680, 370, 150, 40, "core")],
        edges: [
          { from: "client", to: "gw", qps: 8420, error_rate: 0.0002, p99_ms: 42, level: "ok", metric: "api.dependency_error_rate" },
          { from: "gw", to: "order", qps: 6180, error_rate: 0.0034, p99_ms: 88, level: "warn", metric: "api.dependency_error_rate" },
          { from: "order", to: "pay", qps: 2140, error_rate: 0.047, p99_ms: 640, level: "bad", alert_id: 4479, metric: "api.dependency_error_rate" },
          { from: "order", to: "dispatch", qps: 860, error_rate: 0.0231, p99_ms: 890, level: "bad", alert_id: 4472, metric: "api.dependency_error_rate" },
          { from: "order", to: "settle", qps: 620, error_rate: 0.0008, p99_ms: 210, level: "ok", metric: "api.dependency_error_rate" },
          { from: "order", to: "risk", qps: 3200, error_rate: 0.0001, p99_ms: 45, level: "ok", metric: "api.dependency_error_rate" },
          { from: "order", to: "notify", qps: 1050, error_rate: 0.0052, p99_ms: 130, level: "warn", metric: "api.dependency_error_rate" },
        ],
        scale: { ok_max: 0.001, warn_max: 0.02 }, suppression: [{ edge: "order→pay", rules: ["R10", "R13"], reason: "上游指标异常压制派生指标告警" }],
      });
    }
    if (req.method === "GET" && path === "/tech/slow-calls") {
      return ok([
        { api_id: "flight.sync", path: "/api/v1/flight/sync", label: "航班同步", p99_ms: 1800, biz_line: "airport" },
        { api_id: "dispatch.respond", path: "/api/v1/dispatch/respond", label: "派单响应", p99_ms: 890, biz_line: "driver" },
        { api_id: "pay.callback", path: "/api/v1/pay/callback", label: "支付回调", p99_ms: 640, biz_line: "all" },
        { api_id: "transfer.submit", path: "/api/v1/transfer/submit", label: "转单提交", p99_ms: 420, biz_line: "transfer" },
      ]);
    }
    if (req.method === "GET" && path === "/alerts") {
      const status = url.searchParams.get("status") || "firing";
      const items = status === "all" ? filteredAlerts : filteredAlerts.filter((x) => x.status === status);
      return ok({ items, meta: { firing: filteredAlerts.filter((x) => x.status === "firing").length, p0: filteredAlerts.filter((x) => x.level === "P0").length, claimed: filteredAlerts.filter((x) => x.status === "claimed").length } });
    }
    const ackMatch = path.match(/^\/alerts\/(\d+)\/ack$/);
    if (req.method === "POST" && ackMatch) {
      const id = Number(ackMatch[1]);
      if (!alerts.some((x) => x.alert_id === id)) return fail(404, 40401, `告警 ${id} 未找到`);
      let body = {};
      try { body = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}"); } catch { /* empty */ }
      const user = body.user || "林舟";
      acked.set(id, { user, at: now.toISOString() });
      return ok({ alert_id: id, status: "claimed", ack_by: user, ack_at: now.toISOString(), mtta_sec: 240, escalation_stopped: true });
    }
    if (req.method === "GET" && path === "/alerts/stats") {
      return ok({ week: "2026-W36", fired: 318, valid: 269, precision: 0.846, target: 0.8, noise_rate: 0.091, mtta_p50_sec: 168, mttr_p50_sec: 940, p0_ack_within5_min: 0.96, top_noisy_rules: [{ rule_id: "R19", fired: 41, valid: 12, precision: 0.29, suggestion: "建议阈值调至 18% 或降为 P3" }, { rule_id: "R14", fired: 28, valid: 11, precision: 0.39, suggestion: "提高小城市分母门槛" }], by_level: { P0: 12, P1: 118, P2: 168, P3: 20 } });
    }
    if (req.method === "GET" && path === "/meta/pipeline") {
      return ok([
        { component: "order-domain-topic (5 线)", status: "ok", throughput: "8,420 msg/s", heartbeat_at: now.toISOString(), detail: "lag 2,210", extra: "retention 7d" },
        { component: "monitor-consumer ×4", status: "ok", throughput: "8,406 msg/s", heartbeat_at: now.toISOString(), detail: "本地缓冲 0", extra: "无状态" },
        { component: "ClickHouse replica-01", status: "ok", throughput: "写入 42ms", heartbeat_at: now.toISOString(), detail: "8C / 32G", extra: "healthy" },
        { component: "ClickHouse replica-02", status: "ok", throughput: "复制延迟 0.3s", heartbeat_at: now.toISOString(), detail: "8C / 32G", extra: "healthy" },
        { component: "RuleEvaluator", status: "ok", throughput: "48 条 / min", heartbeat_at: now.toISOString(), detail: "求值 328ms", extra: "20 规则启用" },
        { component: "T+1 reconciler", status: "warn", throughput: "缺口 23 笔", heartbeat_at: now.toISOString(), detail: "等待重算", extra: "job rc-20260903-07" },
      ]);
    }
    if (req.method === "GET" && path === "/meta/lag") {
      return ok({ consumer_lag: { p50_sec: 0.4, p99_sec: 1.2, max_partition: "carpool-3" }, ingest_delay: { p50_sec: 2, p99_sec: 372, threshold_p99_sec: 300, status: "bad" }, late: { definition: "ingest_time − event_time > 10min", rate: 0.00018, cnt: 412 }, buffered_fallback: { local_disk_events: 0, replaying: false } });
    }
    if (req.method === "GET" && path === "/meta/reconcile") {
      return ok({ dt: now.toISOString().slice(0, 10), state_gap_cnt: 23, by_biz_line: { carpool: 11, driver: 8, transfer: 4 }, missing_top: [{ event_type: "order_delivered", cnt: 9, reason: "送达打卡未发事件" }, { event_type: "settlement_credited", cnt: 7, reason: "结算重试期间事件丢失" }, { event_type: "passenger_boarded", cnt: 7, reason: "上车打卡事件未发" }], samples: [], dirty_reason_top: [] });
    }
    if (req.method === "GET" && path === "/dict/biz-lines") {
      const volumes = { driver: 286412, transfer: 42180, carpool: 128463, designated: 68924, airport: 31886, all: 557865 };
      const owners = { driver: "韩青", transfer: "邵可", carpool: "程一帆", designated: "金路", airport: "纪南", all: "林舟" };
      const boards = { all: ["sentinel", "business", "quality", "service", "risk", "tech"], driver: ["sentinel", "business", "quality", "tech"], transfer: ["sentinel", "business", "tech"], carpool: ["sentinel", "business", "quality", "risk"], designated: ["sentinel", "business", "quality"], airport: ["sentinel", "business", "quality"] };
      const meta = [["all", "全平台总览", "全平台", "#6558d3", "globe"], ["driver", "司机端", "司机端", "#3587e7", "car"], ["transfer", "转单端", "转单端", "#e0923f", "repeat"], ["carpool", "顺风车", "顺风车", "#25a579", "users"], ["designated", "代驾", "代驾", "#c56ad0", "wine"], ["airport", "接送机", "接送机", "#dc5a58", "plane"]];
      return ok(meta.map(([id, label, short_name, color, icon]) => ({ id, label, short_name, color, icon, daily_orders: volumes[id], owner: owners[id], boards: boards[id] })));
    }
    return fail(404, 40401, `接口 ${path} 未找到`);
  } catch (e) {
    return fail(500, 50001, e?.message || "INTERNAL");
  }
}
