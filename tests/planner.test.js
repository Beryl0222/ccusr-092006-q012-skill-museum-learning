import assert from "node:assert/strict";
import test from "node:test";
import { buildSubteams, fitSubteamsToVenue, planVisit } from "../src/planner.js";
import { Store, normalizeStation } from "../src/store.js";

function venue() {
  const store = new Store();
  const stations = [
    { id: "robotics", zone: "A", risk_level: "high", requires_instructor: true, duration_min: 25, changeover_min: 10, devices: 6, people_per_device: 2, safety_capacity: 12, accessible_bays: 2, tags: ["robotics"], age_min: 10, age_max: 18 },
    { id: "woodwork", zone: "B", risk_level: "high", requires_instructor: true, duration_min: 30, changeover_min: 10, devices: 8, safety_capacity: 8, accessible_bays: 1, tags: ["craft"], age_min: 8, age_max: 18 },
    { id: "weaving", zone: "B", risk_level: "low", duration_min: 20, changeover_min: 5, devices: 10, safety_capacity: 12, accessible_bays: 3, tags: ["craft", "art"], age_min: 6, age_max: 18 },
  ];
  for (const st of stations) store.append("STATION_REGISTERED", st.id, { station: normalizeStation(st) });
  for (const ins of [
    { id: "i1", qualifications: ["robotics"] },
    { id: "i2", qualifications: ["woodwork", "craft"] },
  ]) store.append("INSTRUCTOR_REGISTERED", ins.id, { instructor: ins });
  return store;
}

const baseGroup = {
  id: "g1", visit_date: "2026-10-15", window: { start_min: 540, end_min: 720 },
  learning_objectives: [{ tag: "robotics", priority: "must" }],
  accessibility_needs: { wheelchair_users: 0 }, splittable: true,
};

test("分组：年龄段切队、陪同均摊、轮椅逐队分布", () => {
  const teams = buildSubteams({
    ...baseGroup,
    age_bands: [{ min_age: 12, max_age: 13, students: 20 }],
    party_size: 24, chaperones: 4, max_subteam_size: 12,
    accessibility_needs: { wheelchair_users: 2 },
  });
  assert.equal(teams.reduce((s, t) => s + t.size, 0), 24);
  assert.equal(teams.reduce((s, t) => s + t.wheelchair_users, 0), 2);
  assert.ok(teams.every((t) => t.size <= 12));
});

test("场馆适配拆队：大于任何可进站点容量的子队被拆小", () => {
  const store = venue();
  const teams = buildSubteams({
    ...baseGroup, age_bands: [{ min_age: 12, max_age: 13, students: 20 }],
    party_size: 20, chaperones: 0, max_subteam_size: 20,
  });
  assert.equal(teams.length, 1);
  const fitted = fitSubteamsToVenue(store.state, teams);
  // 可进站最小安全容量 8（woodwork）→ 20 人拆成 3 队。
  assert.ok(fitted.length >= 2);
  assert.equal(fitted.reduce((s, t) => s + t.students, 0), 20);
  assert.ok(fitted.every((t) => t.size <= 8));
});

test("规划：高风险站必带合格讲师，无讲师则留空并给出取舍说明", () => {
  const store = venue();
  // 移除木工讲师，robotics 讲师保留。
  store.state.instructors.delete("i2");
  const plan = planVisit(store.state, { ...baseGroup, party_size: 8, chaperones: 0, age_bands: [{ min_age: 12, max_age: 13, students: 8 }], max_subteam_size: 8 }, {});
  const wood = plan.legs.filter((l) => l.station_id === "woodwork");
  assert.equal(wood.length, 0);
  assert.ok(plan.tradeoffs.some((t) => t.station_id === "woodwork" && t.code === "instructor_unavailable"));
  const robot = plan.legs.find((l) => l.station_id === "robotics");
  assert.equal(robot.instructor_id, "i1");
});

test("规划：must 目标优先满足；所有环节不超站点容量", () => {
  const store = venue();
  const plan = planVisit(store.state, {
    ...baseGroup, party_size: 16, chaperones: 0, max_subteam_size: 8,
    age_bands: [{ min_age: 12, max_age: 13, students: 16 }],
  }, {});
  const robotTeams = new Set(plan.legs.filter((l) => l.station_id === "robotics").map((l) => l.subteam_id));
  assert.ok(robotTeams.size >= 1);
  // 逐分钟校验容量（含换场）。
  for (const leg of plan.legs) {
    const others = plan.legs.filter((o) => o !== leg);
    for (let m = leg.start; m < leg.end; m++) {
      const n = others.filter((o) => o.station_id === leg.station_id && m >= o.start && m < o.end).reduce((s, o) => s + o.size, 0) + leg.size;
      assert.ok(n <= store.state.stations.get(leg.station_id).safety_capacity);
    }
  }
});
