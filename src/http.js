// HTTP 适配层：零依赖 node:http。
// 鉴权：X-Museum-Token（馆方）与 X-Teacher-Token（老师，仅限本团队）。
// 所有写请求由服务层同一把命令锁串行化，并发确认不会突破容量上限。

import { createServer } from "node:http";
import { ServiceError, SchedulingService } from "./service.js";

const MUSEUM_TOKEN = process.env.MUSEUM_TOKEN ?? "museum-demo-token";

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new ServiceError("body_too_large", "请求体过大", { status: 413 }));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ServiceError("bad_json", "请求体不是合法 JSON", { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// 简单模式路由：[method, pattern] → handler，:param 从路径提取。
function compile(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(`^${pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; })}$`);
  return { method, rx, keys, handler };
}

export function createHandler(service) {
  const routes = [
    // 场馆维护
    compile("POST", "/museum/stations", (m, b) => service.registerStation(b, m.token)),
    compile("PATCH", "/museum/stations/:id", (m, b) => service.updateStation(m.params.id, b, m.token)),
    compile("POST", "/museum/stations/:id/equipment", (m, b) =>
      service.setEquipmentStatus({ station_id: m.params.id, ...b }, m.token)),
    compile("POST", "/museum/instructors", (m, b) => service.registerInstructor(b, m.token)),
    compile("POST", "/museum/instructors/:id/availability", (m, b) =>
      service.setInstructorAvailability({ instructor_id: m.params.id, ...b }, m.token)),
    compile("POST", "/museum/corridors", (m, b) => service.registerCorridor(b, m.token)),
    // 馆方视图与裁决
    compile("GET", "/museum/view", (m, b, q) =>
      service.museumView(q.date, m.token, { nowMin: q.now_min ? Number(q.now_min) : null })),
    compile("POST", "/museum/groups/:id/replan", (m, b) => service.replan(m.params.id, m.token, b)),
    compile("POST", "/museum/escalations/:id/decide", (m, b) => service.decideEscalation(m.params.id, m.token, b)),
    compile("POST", "/museum/groups/:id/reconcile", (m, b) => service.museumReconcile(m.params.id, m.token, b)),
    // 学校侧
    compile("POST", "/school/requests", (m, b) => service.submitRequest(b)),
    compile("GET", "/school/groups/:id/itinerary", (m, b, q) =>
      service.teacherView(m.params.id, m.token, { nowMin: q.now_min ? Number(q.now_min) : null })),
    compile("POST", "/school/groups/:id/accept", (m) => service.acceptItinerary(m.params.id, m.token)),
    compile("POST", "/school/groups/:id/reject", (m, b) => service.rejectItinerary(m.params.id, m.token, b?.reason)),
    compile("PATCH", "/school/groups/:id", (m, b) => service.updateGroupBeforeVisit(m.params.id, b, m.token)),
    compile("POST", "/school/groups/:id/progress", (m, b) => service.reportProgress(m.params.id, m.token, b)),
    compile("POST", "/school/groups/:id/replan", (m, b) => service.replan(m.params.id, m.token, b)),
    compile("POST", "/school/groups/:id/reconciliation/confirm", (m, b) =>
      service.schoolConfirmReconciliation(m.params.id, m.token, b)),
    // 事件流（只给馆方，用于审计/重放）
    compile("GET", "/museum/events", (m, b, q) => {
      if (m.token !== service.museumToken) throw new ServiceError("unauthorized", "需要馆方凭证", { status: 403 });
      const events = q.subject ? service.store.events.filter((e) => e.subject_id === q.subject) : service.store.events;
      return { count: events.length, events };
    }),
  ];

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      const match = routes.find((r) => r.method === req.method && r.rx.test(url.pathname));
      if (!match) return json(res, 404, { error: "not_found", message: `无此路由: ${req.method} ${url.pathname}` });
      const cap = match.rx.exec(url.pathname);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(cap[i + 1])]));
      const query = Object.fromEntries(url.searchParams);
      const token = req.headers["x-museum-token"] || req.headers["x-teacher-token"] || "";
      const body = ["GET", "HEAD"].includes(req.method) ? {} : await readBody(req);
      const result = await match.handler({ params, token }, body, query);
      return json(res, 200, result);
    } catch (err) {
      if (err instanceof ServiceError) {
        return json(res, err.status ?? 400, {
          error: err.code, message: err.message,
        });
      }
      return json(res, 500, { error: "internal", message: String(err?.message ?? err) });
    }
  };
}

export function createApp(service = new SchedulingService({ museumToken: MUSEUM_TOKEN })) {
  return createServer(createHandler(service));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const service = new SchedulingService({ museumToken: MUSEUM_TOKEN });
  if (process.env.SEED_DEMO === "1") {
    const { loadSeed } = await import("./seed.js");
    await loadSeed(service);
  }
  const app = createServer(createHandler(service));
  app.listen(port, () => {
    console.log(`技能研学资源编排服务已启动: http://localhost:${port}${process.env.SEED_DEMO === "1" ? "（已载入虚构种子数据）" : ""}`);
  });
}
