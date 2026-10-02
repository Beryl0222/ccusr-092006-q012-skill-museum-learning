// 端到端演示：把研学高峰当天的完整故事走一遍。
//   node scripts/demo.js
//
// 场景：启航中学（42 学生 + 3 陪同，含 2 名轮椅学生）与星光小学同日到馆；
// 暂存到期释放、并发确认不超额、机器人设备校准、木工讲师缺席、
// 团队迟到、陪同临时增加、高风险升级与馆方裁决、馆方/老师视图、事后核对。

import { seededService } from "../src/seed.js";
import { EQUIPMENT_STATUS } from "../src/domain.js";

const M = "museum-demo-token";
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const line = (t = "") => console.log(t);
const head = (t) => line(`\n=== ${t} ===`);
function legs(view) {
  for (const l of view.legs) {
    const flag = l.risk_level === "high" ? " ⚠高风险" : "";
    const ins = l.instructor_name ? ` | 讲师:${l.instructor_name}` : "";
    const phase = { completed: " ✓已完成", skipped: " ✗已跳过", in_progress: " …进行中", interrupted: " ⛔中断待裁决", due: " ·应到场", planned: "" }[l.phase] ?? "";
    line(`  [${l.subteam_id}] ${hhmm(l.start)}-${hhmm(l.end)} ${l.station_name} (${l.size}人${l.wheelchair_users ? `,轮椅${l.wheelchair_users}` : ""})${ins}${flag}${phase}`);
  }
}
function tradeoffs(view) {
  if (!view.tradeoffs?.length) return;
  line("  取舍说明:");
  for (const t of view.tradeoffs) line(`    - [${t.subteam_id ?? "-"}] ${t.station_id}: ${t.reason || t.code}`);
}
function escs(view) {
  for (const e of view.escalations ?? []) line(`    升级件 ${e.escalation_id}: ${e.station_id} / ${e.subteam_id ?? "-"} / ${e.reason} [${e.status}]`);
}

// 可控时钟：初始 09:00，演示中手动推进。
let clock = new Date("2026-10-15T09:00:00+08:00");
const { service, seed } = await seededService({ holdTtlMin: 30, now: () => clock });
const qihangSeed = seed.groups[0];
const xingguangSeed = seed.groups[1];

head("1. 启航中学提交需求：年龄结构/目标/窗口/无障碍/可拆分");
const held1 = await service.submitRequest({ ...qihangSeed, teacher_token: "token-wang" });
line(`暂存 ${held1.hold_id}，将于 ${held1.expires_at} 释放；方案状态=${held1.status}`);
line(`分组: ${held1.subteams.map((t) => `${t.id}(${t.students}生+${t.chaperones}陪,轮椅${t.wheelchair_users})`).join("，")}`);
legs(held1); tradeoffs(held1);

head("2. 学校迟迟不确认 —— 暂存到期自动释放");
clock = new Date("2026-10-15T09:45:00+08:00");
await service.museumView("2026-10-15", M); // 任意写/读命令触发清扫（museumView 本身同步，走一次 reject 触发）
await service.rejectItinerary(held1.group_id, "token-wang", "demo-expire-touch").catch(() => {});
line(`旧暂存状态: ${service.teacherView(held1.group_id, "token-wang").status}（名额已不再占用）`);
try {
  await service.acceptItinerary(held1.group_id, "token-wang");
} catch (e) { line(`确认被拒绝: ${e.code} —— ${e.message}`); }

head("3. 星光小学与启航补申请并发提交，随后并发确认（同一事件锁串行裁决，均不超额）");
clock = new Date("2026-10-15T09:46:00+08:00");
const [xg, qh] = await Promise.all([
  service.submitRequest({ ...xingguangSeed, teacher_token: "token-chen" }),
  service.submitRequest({ ...qihangSeed, teacher_token: "token-wang" }),
]);
line(`星光方案 ${xg.legs.length} 个环节；启航方案 ${qh.legs.length} 个环节（先到先得）`);
const [a1, a2] = await Promise.all([
  service.acceptItinerary(xg.group_id, "token-chen"),
  service.acceptItinerary(qh.group_id, "token-wang"),
]);
line(`并发确认结果: 星光=${a1.status}, 启航=${a2.status}`);

head("4. 馆方视图：拥堵与闲置");
const mv = service.museumView("2026-10-15", M);
for (const s of mv.stations) {
  line(`  ${s.name.padEnd(9)} 峰值${String(s.peak_people).padStart(2)}/${s.safety_capacity} 利用率${s.utilization ?? "-"} ${s.congested ? "⚠拥堵" : ""} ${s.idle ? "闲置" : ""}`);
}
for (const c of mv.corridors) line(`  通道 ${c.corridor_id}: 峰值${c.peak_people}/${c.capacity}${c.congested ? " ⚠拥堵" : ""}`);

head("5. 10:10 突发：机器人站设备校准（停用 40 分钟）+ 木工讲师接连缺席");
// 老师先把 10:10 前已结束的环节全部回报为已完成（这些环节重排时必须保留）。
for (const l of service.teacherView(qh.group_id, "token-wang").legs) {
  if (l.end <= 610) {
    await service.reportProgress(qh.group_id, "token-wang", { station_id: l.station_id, subteam_id: l.subteam_id, status: "completed", at_minute: l.end });
  }
}
await service.setEquipmentStatus({
  station_id: "robotics", status: EQUIPMENT_STATUS.CALIBRATING,
  date: "2026-10-15", from_min: 610, to_min: 650, note: "开馆后例行校准超时",
}, M);
// 孙老师整日缺席；李老师 10:00 起身体不适离场——此时 T6 正在木工站（高风险）体验中。
await service.setInstructorAvailability({ instructor_id: "ins-sun", status: "absent", date: "2026-10-15", from_min: 600, to_min: 750 }, M);
await service.setInstructorAvailability({ instructor_id: "ins-li", status: "absent", date: "2026-10-15", from_min: 600, to_min: 750 }, M);
const rp1 = await service.replan(qh.group_id, M, { reason: "instructor_absent", now_min: 610 });
line(`重规划第 ${rp1.replan_count} 版，已完成环节全部保留；新路线:`);
legs(rp1); tradeoffs(rp1);
line("  安全升级:"); escs(rp1);

head("6. 高风险绝不自动无人指导 —— 馆方对每件升级逐一裁决：备班木工讲师吴老师持证补位");
await service.registerInstructor({ id: "ins-wu", name: "吴老师（备班木艺讲师）", qualifications: ["woodwork", "craft"] }, M);
let decidedView = service.teacherView(qh.group_id, "token-wang");
let round = 0;
while (true) {
  const open = decidedView.escalations.filter((e) => e.station_id === "woodwork" && e.status === "open");
  if (!open.length) break;
  const esc = open[0];
  // 先尝试派吴老师；若系统反馈该子队物理上排不进（容量/时长），改判取消该环节。
  const tryAssign = await service.decideEscalation(esc.escalation_id, M, {
    decision: "assign_instructor", instructor_id: "ins-wu", at_minute: 615, note: "吴老师持木工资格，从备班岗补位",
  });
  const bounced = tryAssign.escalations.find((e) => e.station_id === "woodwork" && e.subteam_id === esc.subteam_id && e.status === "open");
  if (bounced) {
    line(`    - ${esc.escalation_id} (${esc.subteam_id}) 派单后系统复核：${bounced.reason.slice(0, 28)}… → 改判取消该队木工环节`);
    decidedView = await service.decideEscalation(bounced.escalation_id, M, {
      decision: "cancel_leg", reason: "instructor_absent", at_minute: 616, note: "该队人数超木工设备数，剩余窗内无法成组，取消",
    });
  } else {
    line(`    - ${esc.escalation_id} (${esc.subteam_id}) 已指派吴老师并落地`);
    decidedView = tryAssign;
  }
  round += 1;
  if (round > 10) break;
}
line("  高风险升级全部闭环；最终路线（不存在无讲师的高风险环节）:");
legs(decidedView);

head("7. 星光小学迟到 25 分钟 + 临时多来 2 名陪同：整体后移并重算容量");
const before = service.teacherView(xg.group_id, "token-chen").legs.length;
const rp2 = await service.replan(xg.group_id, "token-chen", {
  reason: "group_late", now_min: 595, party_patch: { add_chaperones: 2 },
});
line(`环节数 ${before} → ${rp2.legs.length}，首环节开始 ${hhmm(Math.min(...rp2.legs.map((l) => l.start)))}`);
legs(rp2); tradeoffs(rp2);

head("8. 老师视图隔离：王老师看不到星光，跨团队访问直接拒绝");
const mine = service.teacherView(qh.group_id, "token-wang");
line(`  王老师读取本团队: ${mine.school_name} / ${mine.legs.length} 个环节`);
try {
  service.teacherView(xg.group_id, "token-wang");
} catch (e) { line(`  跨团队访问被拒: ${e.code} (HTTP ${e.status})`); }

head("9. 活动结束：馆方核对实际体验/跳过原因/设备异常，学校确认");
for (const l of service.teacherView(qh.group_id, "token-wang").legs) {
  if (l.phase === "completed" || l.phase === "skipped" || l.phase === "interrupted") continue;
  await service.reportProgress(qh.group_id, "token-wang", { station_id: l.station_id, subteam_id: l.subteam_id, status: "completed", at_minute: l.end });
}
const rec = await service.museumReconcile(qh.group_id, M, { museum_note: "校准期间已为受影响小队补排其他站点" });
line(`  核对条目 ${rec.items.length} 条；示例:`);
for (const it of rec.items.slice(0, 6)) {
  const anom = it.equipment_anomalies.length ? ` | 设备异常:${it.equipment_anomalies.map((a) => a.status).join(",")}` : "";
  line(`    [${it.subteam_id}] ${it.station_name}: ${it.actual_status}${it.skip_reason ? `/${it.skip_reason}` : ""}${anom} | 高风险有人指导:${it.supervised}`);
}
const confirmed = await service.schoolConfirmReconciliation(qh.group_id, "token-wang", {
  accepted: true, items: [], note: "实际体验与方案一致，感谢补排",
});
line(`  学校确认: accepted=${confirmed.school.accepted}，备注「${confirmed.school.note}」`);

head("10. 事件流可重放（审计）");
line(`  共记录 ${service.store.events.length} 个领域事件；重放后归约一致…`);
service.store.replay();
line(`  团队 ${service.store.state.groups.size} 个、站点 ${service.store.state.stations.size} 个、升级件 ${service.store.state.escalations.size} 件。`);
line("\n演示完成。");
