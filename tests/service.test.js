import assert from "node:assert/strict";
import test from "node:test";
import { seededService } from "../src/seed.js";
import { SchedulingService, ServiceError } from "../src/service.js";
import { EQUIPMENT_STATUS } from "../src/domain.js";

const M = "museum-demo-token";

async function fresh(now = () => new Date("2026-10-15T09:00:00+08:00")) {
  return seededService({ holdTtlMin: 30, now });
}

// 不变量：任何行程中高风险环节都必须有合格讲师。
function assertNoUnsupervisedHighRisk(service, groupId) {
  const it = service.store.state.itineraries.get(groupId);
  for (const leg of it.proposal.legs) {
    if (leg.risk_level !== "high" || leg.actual_status === "skipped") continue;
    assert.ok(leg.instructor_id, `高风险环节 ${leg.subteam_id}/${leg.station_id} 无讲师`);
    const ins = service.store.state.instructors.get(leg.instructor_id);
    const st = service.store.state.stations.get(leg.station_id);
    const qualified = ins.qualifications.includes("any") ||
      ins.qualifications.includes(st.id) || st.tags.some((t) => ins.qualifications.includes(t));
    assert.ok(qualified, `讲师 ${leg.instructor_id} 不具备 ${leg.station_id} 工种资格`);
  }
}

test("暂存到期自动释放，到期后不可确认", async () => {
  let clock = new Date("2026-10-15T09:00:00+08:00");
  const { service, seed } = await fresh(() => clock);
  const held = await service.submitRequest({ ...seed.groups[0], teacher_token: "t" });
  assert.equal(held.status, "held");
  clock = new Date("2026-10-15T09:45:00+08:00");
  // 过期后任何馆方写命令触发清扫。
  await service.registerCorridor({ id: "corr-extra", capacity: 1, connects_zones: ["X", "Y"] }, M);
  assert.equal(service.teacherView(held.group_id, "t").status, "expired");
  await assert.rejects(() => service.acceptItinerary(held.group_id, "t"), (e) => e.code === "hold_expired");
});

test("主动放弃暂存立即释放名额，第二团队可补位", async () => {
  const { service, seed } = await fresh();
  const a = await service.submitRequest({ ...seed.groups[0], teacher_token: "ta" });
  await service.rejectItinerary(a.group_id, "ta", "changed_plan");
  const b = await service.submitRequest({ ...seed.groups[0], group: { id: "grp-second", school_name: "另一所学校", teacher_name: "刘老师" }, teacher_token: "tb" });
  assert.equal(b.status, "held");
  assert.ok(b.legs.length > 0);
});

test("并发提交与并发确认：全部成功且任何站点分钟占用不超容量", async () => {
  const { service, seed } = await fresh();
  const requests = [
    service.submitRequest({ ...seed.groups[0], teacher_token: "t1" }),
    service.submitRequest({ ...seed.groups[1], group: { id: "grp-b", school_name: "B 校", teacher_name: "b" }, teacher_token: "t2" }),
    service.submitRequest({ ...seed.groups[1], group: { id: "grp-c", school_name: "C 校", teacher_name: "c" }, visit_window: { start_min: 540, end_min: 660 }, teacher_token: "t3" }),
  ];
  const held = await Promise.all(requests);
  await Promise.all(held.map((h, i) => service.acceptItinerary(h.group_id, `t${i + 1}`)));
  // 直接从容量内核校验所有 accepted 行程的每分钟占用。
  const { buildOccupancy } = await import("../src/capacity.js");
  const occ = buildOccupancy(service.store.state, "2026-10-15");
  for (const st of service.store.state.stations.values()) {
    for (const [minute, v] of occ.stationMin.get(st.id) ?? []) {
      assert.ok(v.people <= st.safety_capacity, `${st.id} @${minute} ${v.people}>${st.safety_capacity}`);
      assert.ok(v.wheelchair <= st.accessible_bays, `${st.id} @${minute} 轮椅 ${v.wheelchair}>${st.accessible_bays}`);
    }
    for (const [minute, n] of occ.instructorMin ? [] : []) { /* noop */ }
  }
  for (const [insId, per] of occ.instructorMin) {
    for (const [minute, n] of per) assert.ok(n <= 1, `讲师 ${insId} @${minute} 同时带 ${n} 场`);
  }
  for (const h of held) assertNoUnsupervisedHighRisk(service, h.group_id);
});

test("设备故障：已完成环节保留，受影响未完成环节重排并记录跳过", async () => {
  const { service, seed } = await fresh();
  const held = await service.submitRequest({ ...seed.groups[0], teacher_token: "t" });
  await service.acceptItinerary(held.group_id, "t");
  const view = service.teacherView(held.group_id, "t");
  // 回报开场前 30 分钟内结束的环节为完成。
  const done = view.legs.filter((l) => l.end <= 575);
  for (const l of done) {
    await service.reportProgress(held.group_id, "t", { station_id: l.station_id, subteam_id: l.subteam_id, status: "completed", at_minute: l.end });
  }
  await service.setEquipmentStatus({ station_id: "robotics", status: EQUIPMENT_STATUS.FAULTED, date: "2026-10-15", from_min: 575, to_min: 700, note: "机械臂报警" }, M);
  const rp = await service.replan(held.group_id, M, { reason: "equipment_fault", now_min: 575 });
  // 已完成的环节仍在新方案中且标记完成。
  for (const l of done) {
    const kept = rp.legs.find((x) => x.leg_id === l.leg_id);
    assert.ok(kept, `已完成环节 ${l.leg_id} 在重排后丢失`);
    assert.equal(kept.phase, "completed");
  }
  // 故障窗内不再有 robotics 计划环节。
  for (const l of rp.legs.filter((x) => x.station_id === "robotics")) {
    const st = service.store.state.stations.get("robotics");
    for (let m = l.start; m < l.end; m++) {
      if (m >= 575 && m < 700) assert.fail("故障窗内仍排了 robotics");
    }
  }
  assertNoUnsupervisedHighRisk(service, held.group_id);
});

test("团队迟到：所有环节开始时间不早于到场时间", async () => {
  const { service, seed } = await fresh();
  const held = await service.submitRequest({ ...seed.groups[1], teacher_token: "t" });
  await service.acceptItinerary(held.group_id, "t");
  const rp = await service.replan(held.group_id, "t", { reason: "group_late", now_min: 600, party_patch: { add_chaperones: 1 } });
  for (const l of rp.legs) assert.ok(l.start >= 600, `${l.station_id} 开始 ${l.start} 早于迟到后到场 600`);
  const totalPeople = rp.subteams.reduce((s, t) => s + t.size, 0);
  assert.equal(totalPeople, 14 + 1);
});

test("讲师缺席高风险：升级、拒绝无资格讲师、合格讲师裁决后落地", async () => {
  const { service, seed } = await fresh();
  const held = await service.submitRequest({ ...seed.groups[0], teacher_token: "t" });
  await service.acceptItinerary(held.group_id, "t");
  // 木工两位讲师全部缺席。
  await service.setInstructorAvailability({ instructor_id: "ins-sun", status: "absent", date: "2026-10-15", from_min: 540, to_min: 750 }, M);
  await service.setInstructorAvailability({ instructor_id: "ins-li", status: "absent", date: "2026-10-15", from_min: 540, to_min: 750 }, M);
  const rp = await service.replan(held.group_id, M, { reason: "instructor_absent", now_min: 560 });
  const woodEsc = rp.escalations.find((e) => e.station_id === "woodwork" && e.status === "open");
  assert.ok(woodEsc, "应产生木工高风险升级件");
  // 老师无权裁决。
  await assert.rejects(() => service.decideEscalation(woodEsc.escalation_id, "t", { decision: "cancel_leg" }), (e) => e.status === 403);
  // 机器人讲师无木工资格，系统拒绝派单。
  await assert.rejects(
    () => service.decideEscalation(woodEsc.escalation_id, M, { decision: "assign_instructor", instructor_id: "ins-zhao" }),
    (e) => e.code === "not_qualified",
  );
  // 登记合格备班讲师并裁决，新方案中该队木工环节落地且由其指导。
  await service.registerInstructor({ id: "ins-wu", qualifications: ["woodwork", "craft"] }, M);
  // 选一个物理上能排进木工站（<=8 人）的升级队。
  const v0 = service.teacherView(held.group_id, "t");
  const smallTeam = v0.subteams.filter((t) => t.size <= 8).map((t) => t.id);
  const target = rp.escalations.find((e) => e.station_id === "woodwork" && e.status === "open" && smallTeam.includes(e.subteam_id));
  const after = await service.decideEscalation(target.escalation_id, M, { decision: "assign_instructor", instructor_id: "ins-wu", at_minute: 565 });
  const landed = after.legs.some((l) => l.station_id === "woodwork" && l.subteam_id === target.subteam_id && l.instructor_id === "ins-wu");
  assert.ok(landed, "合格讲师裁决后环节应落地");
  assertNoUnsupervisedHighRisk(service, held.group_id);
});

test("馆方裁决取消高风险环节：该队该站被封禁并记跳过原因", async () => {
  const { service, seed } = await fresh();
  const held = await service.submitRequest({ ...seed.groups[0], teacher_token: "t" });
  await service.acceptItinerary(held.group_id, "t");
  await service.setInstructorAvailability({ instructor_id: "ins-sun", status: "absent", date: "2026-10-15", from_min: 540, to_min: 750 }, M);
  await service.setInstructorAvailability({ instructor_id: "ins-li", status: "absent", date: "2026-10-15", from_min: 540, to_min: 750 }, M);
  const rp = await service.replan(held.group_id, M, { reason: "instructor_absent", now_min: 560 });
  const esc = rp.escalations.find((e) => e.station_id === "woodwork" && e.status === "open");
  const after = await service.decideEscalation(esc.escalation_id, M, { decision: "cancel_leg", at_minute: 566 });
  assert.equal(after.status, "accepted");
  assert.ok(!after.legs.some((l) => l.station_id === "woodwork" && l.subteam_id === esc.subteam_id && l.phase !== "skipped"));
  assertNoUnsupervisedHighRisk(service, held.group_id);
});

test("老师凭证隔离：只能读本团队行程，跨团队与伪造凭证被拒", async () => {
  const { service, seed } = await fresh();
  const a = await service.submitRequest({ ...seed.groups[0], teacher_token: "ta" });
  const b = await service.submitRequest({ ...seed.groups[1], teacher_token: "tb" });
  assert.equal(service.teacherView(a.group_id, "ta").group_id, a.group_id);
  assert.throws(() => service.teacherView(b.group_id, "ta"), (e) => e.status === 403);
  assert.throws(() => service.museumView("2026-10-15", "ta"), (e) => e.status === 403);
});

test("事后核对：逐条给出实际状态/跳过原因/设备异常，学校确认落库", async () => {
  const { service, seed } = await fresh();
  const held = await service.submitRequest({ ...seed.groups[0], teacher_token: "t" });
  await service.acceptItinerary(held.group_id, "t");
  const view = service.teacherView(held.group_id, "t");
  const first = view.legs[0];
  await service.reportProgress(held.group_id, "t", { station_id: first.station_id, subteam_id: first.subteam_id, status: "completed", at_minute: first.end });
  await service.setEquipmentStatus({ station_id: first.station_id, status: EQUIPMENT_STATUS.CALIBRATING, date: "2026-10-15", from_min: first.end + 5, to_min: first.end + 30, note: "校准" }, M);
  const rec = await service.museumReconcile(held.group_id, M, { museum_note: "核对" });
  assert.ok(rec.items.length >= 1);
  const item = rec.items.find((i) => i.subteam_id === first.subteam_id && i.station_id === first.station_id);
  assert.equal(item.actual_status, "completed");
  const confirmed = await service.schoolConfirmReconciliation(held.group_id, "t", { accepted: true, items: [], note: "无误" });
  assert.equal(confirmed.school.accepted, true);
  // 馆方未发起前学校不能确认。
  const other = await service.submitRequest({ ...seed.groups[1], teacher_token: "t2" });
  await assert.rejects(() => service.schoolConfirmReconciliation(other.group_id, "t2", { accepted: true }), (e) => e.code === "no_reconciliation");
});

test("陪同临时增加：沿用既有子队编号且重算容量", async () => {
  const { service, seed } = await fresh();
  const held = await service.submitRequest({ ...seed.groups[0], teacher_token: "t" });
  await service.acceptItinerary(held.group_id, "t");
  const beforeIds = held.subteams.map((t) => t.id);
  const rp = await service.replan(held.group_id, "t", { reason: "party_change", now_min: 560, party_patch: { add_chaperones: 2 } });
  assert.deepEqual(rp.subteams.map((t) => t.id), beforeIds);
  assert.equal(rp.subteams.reduce((s, t) => s + t.chaperones, 0), 5);
  assertNoUnsupervisedHighRisk(service, held.group_id);
});
