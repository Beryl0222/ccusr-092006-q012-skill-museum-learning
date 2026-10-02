import assert from "node:assert/strict";
import test from "node:test";
import { Store, normalizeStation } from "../src/store.js";
import { buildOccupancy, checkLeg, checkMove, stationCapAt, equipmentStatusAt } from "../src/capacity.js";
import { EQUIPMENT_STATUS } from "../src/domain.js";

const DATE = "2026-10-15";

function storeWith(station, extras = {}) {
  const store = new Store();
  store.append("STATION_REGISTERED", station.id, { station: normalizeStation(station) });
  if (extras.instructor) store.append("INSTRUCTOR_REGISTERED", extras.instructor.id, { instructor: extras.instructor });
  if (extras.corridor) store.append("CORRIDOR_REGISTERED", extras.corridor.id, { corridor: extras.corridor });
  return store;
}

test("设备校准/故障期间分钟容量为 0", () => {
  const store = storeWith({ id: "s1", devices: 4, safety_capacity: 8, people_per_device: 2 });
  store.append("STATION_EQUIPMENT_STATUS", "s1", {
    station_id: "s1", status: EQUIPMENT_STATUS.CALIBRATING, date: DATE, from_min: 600, to_min: 630,
  });
  const st = store.state.stations.get("s1");
  assert.equal(stationCapAt(st, DATE, 599), 8);
  assert.equal(stationCapAt(st, DATE, 600), 0);
  assert.equal(stationCapAt(st, DATE, 629), 0);
  assert.equal(stationCapAt(st, DATE, 630), 8);
  assert.equal(equipmentStatusAt(st, DATE, 610), EQUIPMENT_STATUS.CALIBRATING);
});

test("安全容量：先占 10 人后，再放 3 人被拒（安全容量 12）", () => {
  const store = storeWith({ id: "s1", devices: 12, safety_capacity: 12 });
  store.append("ITINERARY_HELD", "g1", {
    hold_id: "h1", expires_at: null,
    proposal: {
      group_id: "g1", date: DATE, window: { start_min: 540, end_min: 720 }, subteams: [],
      legs: [{ leg_id: "l0", subteam_id: "T1", station_id: "s1", start: 600, end: 620, changeover_end: 620, size: 10, wheelchair_users: 0, actual_status: null }],
      moves: [], tradeoffs: [],
    },
  });
  const occ = buildOccupancy(store.state, DATE);
  const ok = checkLeg(store.state, DATE, {
    leg_id: "x", subteam_id: "T2", station_id: "s1", start: 605, end: 625,
    changeover_end: 625, changeover_min: 0, size: 2, wheelchair_users: 0,
  }, occ);
  assert.deepEqual(ok, []);
  const bad = checkLeg(store.state, DATE, {
    leg_id: "y", subteam_id: "T3", station_id: "s1", start: 605, end: 625,
    changeover_end: 625, changeover_min: 0, size: 3, wheelchair_users: 0,
  }, occ);
  assert.ok(bad.some((v) => v.type === "station_over_capacity"));
});

test("换场时间硬封锁：新环节不得压在别人的换场分钟上", () => {
  const store = storeWith({ id: "s1", devices: 12, safety_capacity: 12, changeover_min: 10 });
  store.append("ITINERARY_HELD", "g1", {
    hold_id: "h1", expires_at: null,
    proposal: {
      group_id: "g1", date: DATE, window: { start_min: 540, end_min: 720 }, subteams: [],
      legs: [{ leg_id: "l0", subteam_id: "T1", station_id: "s1", start: 600, end: 620, changeover_min: 10, changeover_end: 630, size: 1, actual_status: null }],
      moves: [], tradeoffs: [],
    },
  });
  const occ = buildOccupancy(store.state, DATE);
  const bad = checkLeg(store.state, DATE, {
    leg_id: "x", subteam_id: "T2", station_id: "s1", start: 625, end: 640,
    changeover_end: 645, changeover_min: 5, size: 1,
  }, occ);
  assert.ok(bad.some((v) => v.type === "changeover_conflict"));
  const good = checkLeg(store.state, DATE, {
    leg_id: "y", subteam_id: "T3", station_id: "s1", start: 630, end: 645,
    changeover_end: 650, changeover_min: 5, size: 1,
  }, occ);
  assert.deepEqual(good, []);
});

test("无障碍工位：轮椅人数不得超过 accessible_bays", () => {
  const store = storeWith({ id: "s1", devices: 12, safety_capacity: 12, accessible_bays: 1 });
  const occ = buildOccupancy(store.state, DATE);
  const bad = checkLeg(store.state, DATE, {
    leg_id: "x", station_id: "s1", start: 600, end: 620, changeover_end: 620, changeover_min: 0, size: 5, wheelchair_users: 2,
  }, occ);
  assert.ok(bad.some((v) => v.type === "accessible_bay_exceeded"));
});

test("高风险站无讲师一律拒绝；讲师资格按工种匹配、不可跨工种", () => {
  const store = storeWith(
    { id: "robotics", risk_level: "high", devices: 6, safety_capacity: 12, tags: ["robotics"] },
    { instructor: { id: "ins-wood", qualifications: ["woodwork", "high-risk"] } },
  );
  const occ = buildOccupancy(store.state, DATE);
  const naked = checkLeg(store.state, DATE, {
    leg_id: "x", station_id: "robotics", start: 600, end: 625, changeover_end: 625, changeover_min: 0, size: 4, instructor_id: null,
  }, occ);
  assert.ok(naked.some((v) => v.type === "instructor_required"));
  const wrongTrade = checkLeg(store.state, DATE, {
    leg_id: "y", station_id: "robotics", start: 600, end: 625, changeover_end: 625, changeover_min: 0, size: 4, instructor_id: "ins-wood",
  }, occ);
  assert.ok(wrongTrade.some((v) => v.type === "instructor_not_eligible"));
});

test("讲师同一时间不可带两个环节", () => {
  const store = storeWith(
    { id: "s1", risk_level: "high", devices: 6, safety_capacity: 12, tags: ["t"] },
    { instructor: { id: "ins-1", qualifications: ["t"] } },
  );
  store.append("ITINERARY_HELD", "g1", {
    hold_id: "h1", expires_at: null,
    proposal: {
      group_id: "g1", date: DATE, window: { start_min: 540, end_min: 720 }, subteams: [],
      legs: [{ leg_id: "l0", subteam_id: "T1", station_id: "s1", start: 600, end: 620, changeover_end: 620, size: 1, instructor_id: "ins-1", actual_status: null }],
      moves: [], tradeoffs: [],
    },
  });
  const occ = buildOccupancy(store.state, DATE);
  const bad = checkLeg(store.state, DATE, {
    leg_id: "x", station_id: "s1", start: 610, end: 630, changeover_end: 630, changeover_min: 0, size: 1, instructor_id: "ins-1",
  }, occ);
  assert.ok(bad.some((v) => v.type === "instructor_double_booked"));
});

test("通道不得超过通行容量；轮椅要求无障碍通道", () => {
  const store = storeWith({ id: "s1", devices: 12, safety_capacity: 12 }, {
    corridor: { id: "c1", capacity: 10, accessible: false, connects_zones: ["A", "B"] },
  });
  store.append("ITINERARY_HELD", "g1", {
    hold_id: "h1", expires_at: null,
    proposal: {
      group_id: "g1", date: DATE, window: { start_min: 540, end_min: 720 }, subteams: [], legs: [],
      moves: [{ move_id: "m0", corridor_id: "c1", start: 600, end: 603, size: 8 }],
      tradeoffs: [],
    },
  });
  const occ = buildOccupancy(store.state, DATE);
  const bad = checkMove(store.state, DATE, { corridor_id: "c1", start: 601, end: 604, size: 3 }, occ);
  assert.ok(bad.some((v) => v.type === "corridor_over_capacity"));
  const noAccess = checkMove(store.state, DATE, { corridor_id: "c1", start: 620, end: 623, size: 1, accessible_required: true }, occ);
  assert.ok(noAccess.some((v) => v.type === "corridor_not_accessible"));
});

test("已完成环节不再占用未来容量（重规划排除自身旧方案）", () => {
  const store = storeWith({ id: "s1", devices: 2, safety_capacity: 2 });
  store.append("ITINERARY_HELD", "g1", {
    hold_id: "h1", expires_at: null,
    proposal: {
      group_id: "g1", date: DATE, window: { start_min: 540, end_min: 720 }, subteams: [],
      legs: [
        { leg_id: "l0", subteam_id: "T1", station_id: "s1", start: 600, end: 620, changeover_end: 620, size: 2, actual_status: null },
        { leg_id: "l1", subteam_id: "T2", station_id: "s1", start: 630, end: 650, changeover_end: 650, size: 2, actual_status: null },
      ],
      moves: [], tradeoffs: [],
    },
  });
  const occ = buildOccupancy(store.state, DATE, { excludeGroupId: "g1", keepLegIds: ["l0"] });
  // 进行中的 l0 保留占用；未开始的 l1 随旧方案整体作废。
  assert.equal(occ.stationMin.get("s1")?.get(605)?.people ?? 0, 2);
  assert.equal(occ.stationMin.get("s1")?.get(635)?.people ?? 0, 0);
});
