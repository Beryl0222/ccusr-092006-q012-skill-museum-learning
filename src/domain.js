// 技能研学资源编排 —— 领域事件约定与最小校验。
//
// 事件流是系统的唯一事实来源：团队提交、场馆维护、暂存/确认、
// 重规划、进度回传、安全审批与事后核对全部以事件表达。

export const EVENT_KINDS = Object.freeze([
  // —— 学校侧 ——
  "GROUP_REQUESTED", // 学校提交研学需求（年龄结构/目标/窗口/无障碍/可拆分范围）
  "GROUP_UPDATED", // 需求变更（如陪同人员临时增加）
  "ITINERARY_ACCEPTED", // 学校确认暂存行程
  "ITINERARY_REJECTED", // 学校放弃暂存（立即释放名额）
  "PROGRESS_REPORTED", // 到场/完成/跳过等实际进度
  "RECONCILIATION_CONFIRMED", // 学校核对实际体验结果
  // —— 场馆侧 ——
  "STATION_REGISTERED", // 互动站建档
  "STATION_CAPACITY_SET", // 遗留事件名（容量/设备数量维护，现由 STATION_UPDATED 承载）
  "STATION_UPDATED", // 设备数量/难度/安全容量等变更
  "STATION_EQUIPMENT_STATUS", // 设备校准/故障/修复
  "INSTRUCTOR_REGISTERED", // 讲师建档（含资格）
  "INSTRUCTOR_AVAILABILITY", // 讲师到场/缺席/排班
  "CORRIDOR_REGISTERED", // 通道（含无障碍属性）建档
  "ITINERARY_HELD", // 生成轮转方案并暂存名额（带到期时间）
  "HOLD_EXPIRED", // 暂存到期，名额自动释放
  "ROUTE_REPLANNED", // 保留已完成环节后的剩余路线调整
  "HIGH_RISK_ESCALATED", // 高风险环节无合格讲师 → 升级馆方人工
  "HIGH_RISK_DECIDED", // 馆方对升级件的裁决（合格讲师/取消环节）
  "VISIT_RECONCILED", // 馆方核对：实际体验/跳过原因/设备异常
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 各事件载荷的必填字段（最小集合，业务层另有细粒度校验）。
export const PAYLOAD_REQUIRED = Object.freeze({
  GROUP_REQUESTED: ["group", "visit_window", "learning_objectives", "age_bands", "party_size", "accessibility_needs", "splittable", "teacher_token"],
  GROUP_UPDATED: ["patch"],
  ITINERARY_ACCEPTED: [],
  ITINERARY_REJECTED: ["reason"],
  PROGRESS_REPORTED: ["station_id", "status"],
  RECONCILIATION_CONFIRMED: ["accepted", "items"],
  STATION_REGISTERED: ["station"],
  STATION_CAPACITY_SET: [],
  STATION_UPDATED: ["patch"],
  STATION_EQUIPMENT_STATUS: ["station_id", "status"],
  INSTRUCTOR_REGISTERED: ["instructor"],
  INSTRUCTOR_AVAILABILITY: ["instructor_id", "status"],
  CORRIDOR_REGISTERED: ["corridor"],
  ITINERARY_HELD: ["proposal"],
  HOLD_EXPIRED: ["hold_id"],
  ROUTE_REPLANNED: ["replan"],
  HIGH_RISK_ESCALATED: ["station_id", "reason"],
  HIGH_RISK_DECIDED: ["decision", "resolution"],
  VISIT_RECONCILED: ["items"],
});

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (record.kind !== undefined && !EVENT_KINDS.includes(record.kind)) problems.push("kind");
  const required = PAYLOAD_REQUIRED[record.kind];
  if (required && typeof record.payload === "object" && record.payload !== null) {
    for (const name of required) {
      if (!(name in record.payload)) problems.push(`payload.${name}`);
    }
  } else if (required && required.length > 0) {
    problems.push("payload");
  }
  return problems;
}

// 风险等级：高风险体验（如机器人、木工机械）必须有具备对应资格的
// 讲师在场指导，任何自动化流程都不得把它改成无人指导。
export const RISK_LEVELS = Object.freeze(["low", "medium", "high"]);

// 站点设备状态。CALIBRATING 期间可用设备数记 0。
export const EQUIPMENT_STATUS = Object.freeze({
  OPERATIONAL: "operational",
  CALIBRATING: "calibrating",
  FAULTED: "faulted",
});

export const INSTRUCTOR_STATUS = Object.freeze({
  AVAILABLE: "available",
  ABSENT: "absent",
});

// 环节实际进度。
export const PROGRESS_STATUS = Object.freeze({
  ARRIVED: "arrived",
  COMPLETED: "completed",
  SKIPPED: "skipped",
});

export const SKIP_REASONS = Object.freeze([
  "equipment_fault",
  "equipment_calibrating",
  "instructor_absent",
  "group_late",
  "group_size_change",
  "capacity_conflict",
  "teacher_choice",
  "other",
]);
