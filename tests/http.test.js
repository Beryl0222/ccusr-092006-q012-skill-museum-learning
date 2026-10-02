import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createApp } from "../src/http.js";
import { SchedulingService } from "../src/service.js";
import { loadSeed } from "../src/seed.js";

const M = "museum-demo-token";

async function server() {
  const service = new SchedulingService({ museumToken: M });
  await loadSeed(service);
  const app = createApp(service);
  app.listen(0);
  await once(app, "listening");
  const port = app.address().port;
  return { app, base: `http://127.0.0.1:${port}`, service };
}

async function call(base, method, path, { token, tokenHeader = "x-museum-token", body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { [tokenHeader]: token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("HTTP：馆方维护 → 学校提交 → 暂存确认 全链路", async () => {
  const { app, base } = await server();
  try {
    const held = await call(base, "POST", "/school/requests", {
      tokenHeader: "x-teacher-token",
      token: "wang",
      body: {
        group: { id: "g-http", school_name: "HTTP 验证学校", teacher_name: "王老师" },
        visit_date: "2026-10-15",
        visit_window: { start_min: 540, end_min: 720 },
        learning_objectives: [{ tag: "robotics", priority: "must" }],
        age_bands: [{ label: "初一", min_age: 12, max_age: 13, students: 20 }],
        party_size: 22, chaperones: 2,
        accessibility_needs: { wheelchair_users: 1 },
        splittable: true, teacher_token: "wang",
      },
    });
    assert.equal(held.status, 200);
    assert.equal(held.json.status, "held");
    assert.ok(held.json.legs.length > 0);
    assert.ok(held.json.expires_at);

    const mine = await call(base, "GET", "/school/groups/g-http/itinerary", { tokenHeader: "x-teacher-token", token: "wang" });
    assert.equal(mine.json.group_id, "g-http");

    const acc = await call(base, "POST", "/school/groups/g-http/accept", { tokenHeader: "x-teacher-token", token: "wang" });
    assert.equal(acc.json.status, "accepted");

    const view = await call(base, "GET", "/museum/view?date=2026-10-15", { token: M });
    assert.equal(view.status, 200);
    assert.ok(view.json.stations.some((s) => s.station_id === "robotics"));
  } finally {
    app.close();
  }
});

test("HTTP：鉴权——无凭证/错凭证 403；未知路由 404", async () => {
  const { app, base } = await server();
  try {
    assert.equal((await call(base, "GET", "/museum/view?date=2026-10-15")).status, 403);
    assert.equal((await call(base, "GET", "/museum/view?date=2026-10-15", { token: "wrong" })).status, 403);
    assert.equal((await fetch(base + "/nope")).status, 404);
    const badRes = await fetch(base + "/museum/stations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-museum-token": M },
      body: "{ not valid json",
    });
    assert.equal(badRes.status, 400);
  } finally {
    app.close();
  }
});

test("HTTP：设备校准→重规划→高风险升级→馆方裁决，老师仅见本团队", async () => {
  const { app, base } = await server();
  try {
    const held = await call(base, "POST", "/school/requests", {
      tokenHeader: "x-teacher-token", token: "t",
      body: {
        group: { id: "g-x", school_name: "X 校", teacher_name: "x" },
        visit_date: "2026-10-15", visit_window: { start_min: 540, end_min: 720 },
        learning_objectives: [{ tag: "craft", priority: "must" }],
        age_bands: [{ label: "初二", min_age: 13, max_age: 14, students: 24 }],
        party_size: 24, chaperones: 0, accessibility_needs: {}, splittable: true, teacher_token: "t",
      },
    });
    await call(base, "POST", "/school/groups/g-x/accept", { tokenHeader: "x-teacher-token", token: "t" });
    await call(base, "POST", "/museum/instructors/ins-sun/availability", {
      token: M, body: { status: "absent", date: "2026-10-15", from_min: 540, to_min: 720 },
    });
    await call(base, "POST", "/museum/instructors/ins-li/availability", {
      token: M, body: { status: "absent", date: "2026-10-15", from_min: 540, to_min: 720 },
    });
    const rp = await call(base, "POST", "/museum/groups/g-x/replan", { token: M, body: { reason: "instructor_absent", now_min: 560 } });
    assert.equal(rp.status, 200);
    const esc = rp.json.escalations.find((e) => e.station_id === "woodwork" && e.status === "open");
    assert.ok(esc, "木工高风险应升级");

    // 无资格讲师被拒。
    const reject = await call(base, "POST", `/museum/escalations/${esc.escalation_id}/decide`, {
      token: M, body: { decision: "assign_instructor", instructor_id: "ins-zhao" },
    });
    assert.equal(reject.json.error, "not_qualified");

    // 馆方取消该高风险环节（合法裁决）。
    const cancel = await call(base, "POST", `/museum/escalations/${esc.escalation_id}/decide`, {
      token: M, body: { decision: "cancel_leg", at_minute: 566 },
    });
    assert.equal(cancel.status, 200);

    // 老师不能裁决。
    const teacherEsc = (await call(base, "GET", "/school/groups/g-x/itinerary", { tokenHeader: "x-teacher-token", token: "t" })).json
      .escalations.find((e) => e.escalation_id === esc.escalation_id);
    assert.equal(teacherEsc.status, "resolved");
  } finally {
    app.close();
  }
});

test("HTTP：并发确认压力（20 个同时请求）不产生超额占用", async () => {
  const { app, base, service } = await server();
  try {
    // 制造高争抢：同一小窗口 20 个小团申请最紧张的木工/机器人容量。
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      call(base, "POST", "/school/requests", {
        tokenHeader: "x-teacher-token", token: `tk${i}`,
        body: {
          group: { id: `g-${i}`, school_name: `学校${i}`, teacher_name: `老师${i}` },
          visit_date: "2026-10-15", visit_window: { start_min: 540, end_min: 600 },
          learning_objectives: [{ tag: "craft", priority: "must" }],
          age_bands: [{ label: "x", min_age: 12, max_age: 13, students: 6 }],
          party_size: 6, chaperones: 0, accessibility_needs: {}, splittable: true, teacher_token: `tk${i}`,
        },
      }).then((r) => call(base, "POST", `/school/groups/g-${i}/accept`, { tokenHeader: "x-teacher-token", token: `tk${i}` })),
    ));
    for (const r of results) assert.equal(r.json.status, "accepted");

    const { buildOccupancy } = await import("../src/capacity.js");
    const occ = buildOccupancy(service.store.state, "2026-10-15");
    for (const st of service.store.state.stations.values()) {
      for (const [minute, v] of occ.stationMin.get(st.id) ?? []) {
        assert.ok(v.people <= st.safety_capacity, `${st.id}@${minute}: ${v.people}>${st.safety_capacity}`);
      }
    }
    for (const [, per] of occ.instructorMin) {
      for (const [, n] of per) assert.ok(n <= 1);
    }
  } finally {
    app.close();
  }
});
