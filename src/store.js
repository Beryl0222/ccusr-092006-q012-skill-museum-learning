// 事件存储：所有状态由领域事件归约得到；命令在同一把异步锁内串行执行，
// 因此"先校验容量、再写入暂存"是原子的，并发确认不会突破任何上限。

import { EQUIPMENT_STATUS, INSTRUCTOR_STATUS } from "./domain.js";

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}-${counter.toString(36)}-${Date.now().toString(36)}`;
}

export class Store {
  constructor() {
    this.events = [];
    this._resetState();
  }

  _resetState() {
    this.state = {
      stations: new Map(),
      corridors: new Map(),
      instructors: new Map(),
      groups: new Map(),
      // groupId -> 当前行程（held/accepted）；被取代的行程进入 history
      itineraries: new Map(),
      // groupId -> 实际进度记录数组
      actuals: new Map(),
      // 高风险升级件
      escalations: new Map(),
      // 馆方裁决结果（跨重排持续有效，直至环节完成或被改判）
      // groupId -> Map("subteam:station" -> instructor_id)
      instructorAssignments: new Map(),
      // groupId -> Set("subteam:station") 裁决取消的高风险环节
      stationBans: new Map(),
      // groupId -> 馆方核对结果 / 学校确认
      reconciliations: new Map(),
    };
  }

  // 串行化所有写命令。
  async withLock(fn) {
    const next = this._lockTail ? this._lockTail.then(() => fn(), () => fn()) : fn();
    this._lockTail = next.then(() => {}, () => {});
    try {
      return await next;
    } finally {
      if (this._lockTail === next || this._lockTail === undefined) {
        // 锁链自然收缩，无需额外处理。
      }
    }
  }

  append(kind, subjectId, payload, { occurredAt = new Date() } = {}) {
    const event = {
      event_id: newId("evt"),
      kind,
      occurred_at: occurredAt.toISOString(),
      subject_id: subjectId,
      payload,
    };
    this.events.push(event);
    this._reduce(event);
    return event;
  }

  // 从空状态重放全部事件（演示/对账时可核对）。
  replay() {
    this._resetState();
    for (const event of this.events) this._reduce(event);
  }

  _reduce(event) {
    const { kind, payload } = event;
    const s = this.state;
    switch (kind) {
      case "STATION_REGISTERED": {
        const st = normalizeStation(payload.station);
        s.stations.set(st.id, st);
        break;
      }
      case "STATION_UPDATED": {
        const st = s.stations.get(payload.station_id ?? payload.id);
        if (st) Object.assign(st, payload.patch);
        break;
      }
      case "STATION_EQUIPMENT_STATUS": {
        const st = s.stations.get(payload.station_id);
        if (st) {
          // 开放式事件（无 from_min）表示"即日起状态变更直至下次上报"，
          // 改写基线；带时间窗的事件只作为分钟级覆盖，不污染基线。
          if (payload.from_min == null) st.equipment_status = payload.status;
          st.equipment_events.push({
            status: payload.status,
            date: payload.date ?? null,
            from_min: payload.from_min ?? null,
            to_min: payload.to_min ?? null,
            note: payload.note ?? "",
            occurred_at: event.occurred_at,
          });
        }
        break;
      }
      case "CORRIDOR_REGISTERED": {
        const c = normalizeCorridor(payload.corridor);
        s.corridors.set(c.id, c);
        break;
      }
      case "INSTRUCTOR_REGISTERED": {
        const ins = normalizeInstructor(payload.instructor);
        s.instructors.set(ins.id, ins);
        break;
      }
      case "INSTRUCTOR_AVAILABILITY": {
        const ins = s.instructors.get(payload.instructor_id);
        if (!ins) break;
        if (payload.status === INSTRUCTOR_STATUS.ABSENT) {
          ins.absences.push({ date: payload.date, from_min: payload.from_min, to_min: payload.to_min });
        } else {
          // 重新到场：移除该日重叠或缺省的缺席区间。
          ins.absences = ins.absences.filter((a) => a.date !== payload.date);
        }
        break;
      }
      case "GROUP_REQUESTED": {
        const g = normalizeGroup(payload);
        s.groups.set(g.id, g);
        break;
      }
      case "GROUP_UPDATED": {
        const g = s.groups.get(payload.group_id);
        if (g && payload.patch) {
          if (payload.patch.accessibility_needs) {
            Object.assign(g.accessibility_needs, payload.patch.accessibility_needs);
            delete payload.patch.accessibility_needs;
          }
          Object.assign(g, payload.patch);
        }
        break;
      }
      case "ITINERARY_HELD": {
        const p = payload.proposal;
        const cur = s.itineraries.get(p.group_id);
        if (cur && (cur.status === "held" || cur.status === "accepted")) {
          cur.history = cur.history ?? [];
          cur.history.push(summarizeItinerary(cur));
        }
        s.itineraries.set(p.group_id, {
          hold_id: payload.hold_id,
          status: "held",
          expires_at: payload.expires_at,
          proposal: p,
          held_at: event.occurred_at,
          history: cur?.history ?? [],
        });
        break;
      }
      case "HOLD_EXPIRED": {
        const it = s.itineraries.get(payload.group_id);
        if (it && it.hold_id === payload.hold_id && it.status === "held") it.status = "expired";
        break;
      }
      case "ITINERARY_ACCEPTED": {
        const it = s.itineraries.get(payload.group_id);
        if (it && it.status === "held") {
          it.status = "accepted";
          it.accepted_at = event.occurred_at;
        }
        break;
      }
      case "ITINERARY_REJECTED": {
        const it = s.itineraries.get(payload.group_id);
        if (it && it.status === "held") it.status = "rejected";
        break;
      }
      case "ROUTE_REPLANNED": {
        // 重规划事件承载新方案，旧的未来环节整体释放（已完成环节由 actuals 保留）。
        const r = payload.replan;
        const cur = s.itineraries.get(r.group_id);
        if (cur) {
          cur.history = cur.history ?? [];
          cur.history.push(summarizeItinerary(cur));
        }
        s.itineraries.set(r.group_id, {
          hold_id: payload.hold_id ?? cur?.hold_id ?? newId("hold"),
          status: "accepted",
          expires_at: null,
          proposal: r.proposal,
          held_at: cur?.held_at,
          accepted_at: cur?.accepted_at,
          replanned_at: event.occurred_at,
          history: cur?.history ?? [],
        });
        break;
      }
      case "PROGRESS_REPORTED": {
        const list = s.actuals.get(payload.group_id) ?? [];
        list.push({
          station_id: payload.station_id,
          subteam_id: payload.subteam_id ?? null,
          status: payload.status,
          reason: payload.reason ?? null,
          at_minute: payload.at_minute ?? null,
          note: payload.note ?? "",
          occurred_at: event.occurred_at,
        });
        s.actuals.set(payload.group_id, list);
        // 同步环节状态，供后续重规划识别"已完成/已到场"。
        const it = s.itineraries.get(payload.group_id);
        if (it) {
          for (const leg of it.proposal.legs) {
            if (leg.station_id === payload.station_id &&
                (!payload.subteam_id || leg.subteam_id === payload.subteam_id)) {
              leg.actual_status = payload.status;
              leg.actual_reason = payload.reason ?? leg.actual_reason ?? null;
            }
          }
        }
        break;
      }
      case "HIGH_RISK_ESCALATED": {
        s.escalations.set(payload.escalation_id, {
          escalation_id: payload.escalation_id,
          group_id: payload.group_id,
          station_id: payload.station_id,
          subteam_id: payload.subteam_id ?? null,
          start: payload.start,
          end: payload.end,
          reason: payload.reason,
          detail: payload.detail ?? "",
          status: "open",
          created_at: event.occurred_at,
        });
        break;
      }
      case "HIGH_RISK_DECIDED": {
        const esc = s.escalations.get(payload.escalation_id);
        if (esc) {
          esc.status = "resolved";
          esc.decision = payload.decision; // "assign_instructor" | "cancel_leg"
          esc.resolution = payload.resolution;
          esc.decided_at = event.occurred_at;
          const key = `${esc.subteam_id ?? ""}:${esc.station_id}`;
          if (payload.decision === "assign_instructor") {
            const m = s.instructorAssignments.get(esc.group_id) ?? new Map();
            m.set(key, payload.resolution.instructor_id);
            s.instructorAssignments.set(esc.group_id, m);
            const b = s.stationBans.get(esc.group_id);
            b?.delete(key);
          } else if (payload.decision === "cancel_leg") {
            const set = s.stationBans.get(esc.group_id) ?? new Set();
            set.add(key);
            s.stationBans.set(esc.group_id, set);
            s.instructorAssignments.get(esc.group_id)?.delete(key);
          }
        }
        break;
      }
      case "VISIT_RECONCILED": {
        s.reconciliations.set(payload.group_id, {
          items: payload.items,
          museum_note: payload.museum_note ?? "",
          museum_at: event.occurred_at,
          school: null,
        });
        break;
      }
      case "RECONCILIATION_CONFIRMED": {
        const rec = s.reconciliations.get(payload.group_id);
        if (rec) {
          rec.school = {
            accepted: payload.accepted,
            items: payload.items ?? [],
            note: payload.note ?? "",
            confirmed_at: event.occurred_at,
          };
        }
        break;
      }
      default:
        break;
    }
  }
}

function summarizeItinerary(it) {
  return {
    hold_id: it.hold_id,
    status: it.status,
    legs: it.proposal.legs.map((l) => ({ ...l })),
    tradeoffs: it.proposal.tradeoffs.map((t) => ({ ...t })),
  };
}

export function normalizeStation(input) {
  return {
    id: input.id,
    name: input.name ?? input.id,
    zone: input.zone ?? "default",
    corridor_id: input.corridor_id,
    tags: input.tags ?? [],
    age_min: input.age_min ?? 6,
    age_max: input.age_max ?? 18,
    risk_level: input.risk_level ?? "low",
    requires_instructor: input.requires_instructor ?? input.risk_level === "high",
    duration_min: input.duration_min ?? 20,
    changeover_min: input.changeover_min ?? 5,
    devices: input.devices ?? 1,
    people_per_device: input.people_per_device ?? 1,
    safety_capacity: input.safety_capacity ?? input.devices ?? 1,
    accessible_bays: input.accessible_bays ?? 0,
    equipment_status: input.equipment_status ?? EQUIPMENT_STATUS.OPERATIONAL,
    equipment_events: input.equipment_events ?? [],
  };
}

function normalizeCorridor(input) {
  return {
    id: input.id,
    name: input.name ?? input.id,
    connects_zones: input.connects_zones ?? [],
    capacity: input.capacity, // 每分钟可同时容纳的通行人数
    accessible: input.accessible ?? false,
    travel_min: input.travel_min ?? 3,
  };
}

function normalizeInstructor(input) {
  return {
    id: input.id,
    name: input.name ?? input.id,
    qualifications: input.qualifications ?? [], // 可指导的站点 id / 风险等级标签
    absences: input.absences ?? [],
  };
}

export function normalizeGroup(payload) {
  const g = payload.group;
  return {
    id: g.id,
    school_name: g.school_name ?? g.id,
    teacher_name: g.teacher_name ?? "",
    teacher_token: payload.teacher_token,
    visit_date: payload.visit_date ?? g.visit_date,
    window: payload.visit_window ?? g.window, // {start_min, end_min}
    learning_objectives: payload.learning_objectives ?? g.learning_objectives ?? [],
    age_bands: payload.age_bands ?? g.age_bands ?? [], // [{label, min_age,max_age,students}]
    party_size: payload.party_size ?? g.party_size,
    chaperones: payload.chaperones ?? g.chaperones ?? 0,
    accessibility_needs: payload.accessibility_needs ?? g.accessibility_needs ?? { wheelchair_users: 0 },
    splittable: payload.splittable ?? g.splittable ?? true,
    max_subteam_size: payload.max_subteam_size ?? g.max_subteam_size ?? 16,
  };
}

// 当前仍占用资源的环节：暂存中或已确认行程内的"计划态"环节。
// 已完成/已跳过/已到场的环节不再参与未来容量校验。
export function liveLegs(state, { date } = {}) {
  const out = [];
  for (const it of state.itineraries.values()) {
    if (it.status !== "held" && it.status !== "accepted") continue;
    for (const leg of it.proposal.legs) {
      if (leg.actual_status && leg.actual_status !== "arrived") continue;
      if (date && it.proposal.date !== date) continue;
      out.push({ leg, itinerary: it });
    }
  }
  return out;
}
