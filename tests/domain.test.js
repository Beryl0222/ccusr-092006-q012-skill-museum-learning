import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_KINDS, validateEvent, EQUIPMENT_STATUS, INSTRUCTOR_STATUS, PROGRESS_STATUS,
} from "../src/domain.js";

test("向后兼容：原始 5 种事件仍在约定中", () => {
  for (const k of ["GROUP_REQUESTED", "STATION_CAPACITY_SET", "ITINERARY_HELD", "ROUTE_REPLANNED", "VISIT_RECONCILED"]) {
    assert.ok(EVENT_KINDS.includes(k), `缺少 ${k}`);
  }
});

test("validateEvent 捕获缺字段与未知 kind", () => {
  assert.deepEqual(validateEvent({ kind: "NOPE", payload: {} }), ["event_id", "occurred_at", "subject_id", "kind"]);
  assert.deepEqual(validateEvent({
    event_id: "e1", kind: "GROUP_REQUESTED", occurred_at: "t", subject_id: "g", payload: {},
  }).filter((p) => p.startsWith("payload")), ["payload.group", "payload.visit_window", "payload.learning_objectives", "payload.age_bands", "payload.party_size", "payload.accessibility_needs", "payload.splittable", "payload.teacher_token"]);
  assert.deepEqual(validateEvent({
    event_id: "e2", kind: "ITINERARY_HELD", occurred_at: "t", subject_id: "g",
    payload: { proposal: {} },
  }), []);
});

test("领域枚举稳定", () => {
  assert.equal(EQUIPMENT_STATUS.CALIBRATING, "calibrating");
  assert.equal(INSTRUCTOR_STATUS.ABSENT, "absent");
  assert.deepEqual(Object.values(PROGRESS_STATUS), ["arrived", "completed", "skipped"]);
});
