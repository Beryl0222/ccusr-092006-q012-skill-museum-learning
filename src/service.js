// 应用服务：暂存名额与到期释放、并发确认、四类突发的重规划、
// 高风险安全红线升级、馆方/老师视图与事后核对。

import { Store } from "./store.js";
import { planVisit, adjustSubteams } from "./planner.js";
import { buildOccupancy, equipmentStatusAt, stationCapAt } from "./capacity.js";
import { EQUIPMENT_STATUS, PROGRESS_STATUS, SKIP_REASONS, validateEvent } from "./domain.js";

let idSeq = 0;
const id = (p) => `${p}-${(idSeq += 1).toString(36)}-${Date.now().toString(36)}`;

export class ServiceError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details ?? {};
  }
}

export class SchedulingService {
  constructor({ holdTtlMin = 30, museumToken = "museum-demo-token", now = () => new Date() } = {}) {
    this.store = new Store();
    this.holdTtlMin = holdTtlMin;
    this.museumToken = museumToken;
    this.now = now;
  }

  // 所有写命令走同一把锁；进入时先回收到期暂存，故并发确认天然串行且不超额。
  async _command(fn) {
    return this.store.withLock(async () => {
      this._sweepExpired();
      return fn();
    });
  }

  _append(kind, subjectId, payload) {
    const event = this.store.append(kind, subjectId, payload, { occurredAt: this.now() });
    const problems = validateEvent(event);
    if (problems.length) throw new ServiceError("domain_validation_failed", `事件字段缺失: ${problems.join(", ")}`);
    return event;
  }

  // —— 场馆资源维护 ——

  registerStation(station, token) {
    return this._command(() => {
      this._requireMuseum(token);
      this._append("STATION_REGISTERED", station.id, { station });
      return this.store.state.stations.get(station.id);
    });
  }

  updateStation(stationId, patch, token) {
    return this._command(() => {
      this._requireMuseum(token);
      if (!this.store.state.stations.has(stationId)) throw new ServiceError("unknown_station", "互动站不存在");
      this._append("STATION_UPDATED", stationId, { station_id: stationId, patch });
      return this.store.state.stations.get(stationId);
    });
  }

  // 设备状态：校准/故障期间按分钟容量记 0；to_min 省略表示持续至再次上报。
  setEquipmentStatus({ station_id, status, date, from_min = null, to_min = null, note = "" }, token) {
    return this._command(() => {
      this._requireMuseum(token);
      const st = this.store.state.stations.get(station_id);
      if (!st) throw new ServiceError("unknown_station", "互动站不存在");
      if (!Object.values(EQUIPMENT_STATUS).includes(status)) throw new ServiceError("bad_status", "未知设备状态");
      this._append("STATION_EQUIPMENT_STATUS", station_id, { station_id, status, date, from_min, to_min, note });
      return this.store.state.stations.get(station_id);
    });
  }

  registerInstructor(instructor, token) {
    return this._command(() => {
      this._requireMuseum(token);
      this._append("INSTRUCTOR_REGISTERED", instructor.id, { instructor });
      return this.store.state.instructors.get(instructor.id);
    });
  }

  setInstructorAvailability({ instructor_id, status, date, from_min = null, to_min = null }, token) {
    return this._command(() => {
      this._requireMuseum(token);
      const ins = this.store.state.instructors.get(instructor_id);
      if (!ins) throw new ServiceError("unknown_instructor", "讲师不存在");
      this._append("INSTRUCTOR_AVAILABILITY", instructor_id, { instructor_id, status, date, from_min, to_min });
      return ins;
    });
  }

  registerCorridor(corridor, token) {
    return this._command(() => {
      this._requireMuseum(token);
      this._append("CORRIDOR_REGISTERED", corridor.id, { corridor });
      return this.store.state.corridors.get(corridor.id);
    });
  }

  // —— 学校侧：提交需求 → 生成带取舍说明的暂存方案 ——

  submitRequest(input) {
    return this._command(() => {
      const groupId = input.group?.id ?? id("grp");
      const teacherToken = input.teacher_token ?? id("teacher-token");
      const payload = { ...input, group: { ...(input.group ?? {}), id: groupId }, teacher_token: teacherToken };
      this._validateGroupPayload(payload);
      this._append("GROUP_REQUESTED", groupId, payload);
      const group = this.store.state.groups.get(groupId);
      return this._holdProposal(group, { trigger: "GROUP_REQUESTED" });
    });
  }

  // 到访前需求变更（如陪同增加、人数调整）：重算暂存。
  updateGroupBeforeVisit(groupId, patch, token) {
    return this._command(() => {
      const group = this._requireGroup(groupId);
      this._requireTeacher(group, token);
      this._append("GROUP_UPDATED", groupId, { group_id: groupId, patch });
      const it = this.store.state.itineraries.get(groupId);
      if (it && (it.status === "held")) return this._holdProposal(this.store.state.groups.get(groupId), { trigger: "GROUP_UPDATED" });
      return it ? this._itineraryView(groupId) : this.store.state.groups.get(groupId);
    });
  }

  acceptItinerary(groupId, token) {
    return this._command(() => {
      const group = this._requireGroup(groupId);
      this._requireTeacher(group, token);
      const it = this.store.state.itineraries.get(groupId);
      if (!it) throw new ServiceError("no_itinerary", "没有可确认的行程");
      if (it.status === "expired") throw new ServiceError("hold_expired", "暂存已到期释放，请重新申请");
      if (it.status !== "held") throw new ServiceError("not_held", `当前状态 ${it.status} 不可确认`);
      this._append("ITINERARY_ACCEPTED", groupId, { group_id: groupId });
      return this._itineraryView(groupId);
    });
  }

  rejectItinerary(groupId, token, reason = "teacher_rejected") {
    return this._command(() => {
      const group = this._requireGroup(groupId);
      this._requireTeacher(group, token);
      const it = this.store.state.itineraries.get(groupId);
      if (!it || it.status !== "held") throw new ServiceError("not_held", "没有可放弃的暂存");
      this._append("ITINERARY_REJECTED", groupId, { group_id: groupId, reason });
      return { status: "rejected", group_id: groupId };
    });
  }

  // —— 到访中的进度回传 ——

  reportProgress(groupId, token, { station_id, subteam_id = null, status, reason = null, at_minute = null, note = "" }) {
    return this._command(() => {
      const group = this._requireGroup(groupId);
      this._requireTeacher(group, token);
      if (!Object.values(PROGRESS_STATUS).includes(status)) throw new ServiceError("bad_status", "未知进度状态");
      if (status === "skipped" && reason && !SKIP_REASONS.includes(reason)) {
        throw new ServiceError("bad_reason", `跳过原因须为: ${SKIP_REASONS.join("/")}`);
      }
      this._append("PROGRESS_REPORTED", groupId, { group_id: groupId, station_id, subteam_id, status, reason, at_minute, note });
      return this._itineraryView(groupId);
    });
  }

  /**
   * 突发重规划。保留已完成/已到场环节，仅重排剩余路线。
   * input.reason: equipment_fault | group_late | instructor_absent | party_change
   */
  replan(groupId, token, input = {}) {
    return this._command(() => {
      const group = this._requireGroup(groupId);
      // 老师可触发（团队迟到/陪同增加），馆方也可触发（设备/讲师）。
      if (token !== group.teacher_token) this._requireMuseum(token);
      const it = this.store.state.itineraries.get(groupId);
      if (!it || (it.status !== "accepted" && it.status !== "held")) {
        throw new ServiceError("no_active_itinerary", "没有进行中的行程");
      }
      const nowMin = input.now_min ?? this._deriveNowMin(group);
      const date = input.date ?? it.proposal.date;
      const escalationsReopened = [];
      const openSame = (stationId, subteamId) =>
        [...this.store.state.escalations.values()].some(
          (e) => e.group_id === groupId && e.station_id === stationId &&
            (e.subteam_id ?? null) === (subteamId ?? null) && e.status === "open",
        );

      // 陪同/学生临时增减：沿用子队编号。
      let subteams = it.proposal.subteams.map((t) => ({ ...t }));
      if (input.party_patch) {
        const p = input.party_patch;
        subteams = adjustSubteams(subteams, {
          addChaperones: p.add_chaperones ?? 0,
          addStudents: p.add_students ?? 0,
          addWheelchairUsers: p.add_wheelchair_users ?? 0,
          maxSize: group.max_subteam_size,
        });
        this._append("GROUP_UPDATED", groupId, {
          group_id: groupId,
          patch: {
            chaperones: group.chaperones + (p.add_chaperones ?? 0),
            party_size: group.party_size + (p.add_chaperones ?? 0) + (p.add_students ?? 0),
          },
        });
      }

      // 识别在 nowMin 时刻已完成/进行中/未开始的环节。
      const frozen = [];
      const interruptedHighRisk = [];
      const lateStart = input.reason === "group_late" ? Math.max(nowMin, it.proposal.window.start_min) : null;
      for (const leg of it.proposal.legs) {
        if (leg.actual_status === "completed") { frozen.push({ ...leg }); continue; }
        if (leg.actual_status === "skipped") continue;
        const station = this.store.state.stations.get(leg.station_id);
        // 迟到场景：nowMin 之前的环节均未开始，整体后移重排。
        const started = leg.actual_status === "arrived" || (lateStart == null && leg.start <= nowMin);
        if (!started) continue;
        if (leg.actual_status !== "arrived" && leg.end <= nowMin) continue; // 时间已过又无回报

        const cap = stationCapAt(station, date, nowMin);
        const equip = equipmentStatusAt(station, date, nowMin);
        if (cap <= 0) {
          // 设备正在校准/故障：进行中的体验被迫中断，记录实际跳过。
          this._append("PROGRESS_REPORTED", groupId, {
            group_id: groupId,
            station_id: leg.station_id,
            subteam_id: leg.subteam_id,
            status: PROGRESS_STATUS.SKIPPED,
            reason: equip === EQUIPMENT_STATUS.CALIBRATING ? "equipment_calibrating" : "equipment_fault",
            at_minute: nowMin,
            note: "设备异常导致环节中断，剩余路线已重排",
          });
          continue;
        }
        if ((station.requires_instructor || station.risk_level === "high") && !this._instructorStillServes(leg, station, date, nowMin)) {
          // 安全红线：进行中的高风险环节讲师缺席，一律冻结现场并升级，
          // 绝不自动改成无人指导，也不静默换讲师充数——由馆方显式裁决。
          if (station.risk_level === "high") {
            frozen.push({ ...leg, interrupted: true });
            interruptedHighRisk.push({ leg: { ...leg, interrupted: true }, station });
            continue;
          }
          // 中低风险：不冻结，交给规划器另派合格讲师；派不出则在取舍中说明。
          continue;
        }
        // 正常进行中 → 原样保留（含其占用）。
        frozen.push({ ...leg });
      }

      const earliest = {};
      if (lateStart != null) {
        for (const t of subteams) earliest[t.id] = lateStart;
      }

      // 馆方既往裁决贯穿后续重排：强制指派的讲师与明令取消的环节保持有效。
      const persistedForce = new Map();
      const forceState = this.store.state.instructorAssignments.get(groupId);
      if (forceState) {
        for (const [key, instructorId] of forceState) {
          const [subteamId, stationId] = key.split(":");
          const ins = this.store.state.instructors.get(instructorId);
          const st = this.store.state.stations.get(stationId);
          const stillServes = ins && st && (
            ins.qualifications.includes("any") ||
            ins.qualifications.includes(st.id) ||
            st.tags.some((tag) => ins.qualifications.includes(tag))
          ) && !ins.absences.some((a) => {
            if (a.date && a.date !== date) return false;
            const from = a.from_min ?? -Infinity;
            const to = a.to_min ?? Infinity;
            return to > nowMin && from < it.proposal.window.end_min;
          });
          if (stillServes) persistedForce.set(`${subteamId}:${stationId}`, instructorId);
          else {
            forceState.delete(key);
            if (!openSame(stationId, subteamId)) {
              // 被指派讲师也不可用了 → 重新升级，绝不静默回落到无人指导。
              escalationsReopened.push(this._openEscalation(groupId, { subteam_id: subteamId, station_id: stationId, start: nowMin, end: null }, st, "已指派讲师也无法到场，等待馆方重新裁决", date, nowMin));
            }
          }
        }
      }
      const persistedBans = [...(this.store.state.stationBans.get(groupId) ?? [])].map((key) => {
        const [subteam_id, station_id] = key.split(":");
        return { subteam_id, station_id };
      });

      const proposal = planVisit(this.store.state, group, {
        date,
        subteams,
        excludeOwn: true,
        protectLegs: frozen,
        earliest,
        forceInstructors: persistedForce,
        bans: persistedBans,
        windowStart: input.reason === "group_late" ? Math.max(nowMin, it.proposal.window.start_min) : it.proposal.window.start_min,
        windowEnd: it.proposal.window.end_min,
      });

      // 高风险站因无合格讲师而落空 → 升级，绝不静默降级或自动改无人指导。
      const escalations = [...escalationsReopened];
      for (const e of interruptedHighRisk) {
        if (openSame(e.station.id, e.leg.subteam_id)) continue;
        escalations.push(this._openEscalation(groupId, e.leg, e.station, "进行中的高风险环节讲师缺席", date, nowMin));
      }
      const plannedNow = new Set(proposal.legs.map((l) => `${l.subteam_id}:${l.station_id}`));
      const interruptedIds = new Set(interruptedHighRisk.map((x) => x.leg.leg_id));
      const tradeoffByKey = new Map(proposal.tradeoffs.map((t) => [`${t.subteam_id}:${t.station_id}`, t]));
      for (const leg of it.proposal.legs) {
        const station = this.store.state.stations.get(leg.station_id);
        if (station?.risk_level !== "high") continue;
        if (leg.actual_status === "completed" || leg.actual_status === "skipped") continue;
        if (interruptedIds.has(leg.leg_id)) continue;
        if (plannedNow.has(`${leg.subteam_id}:${leg.station_id}`)) continue;
        if (openSame(leg.station_id, leg.subteam_id)) continue;

        const reason = tradeoffByKey.get(`${leg.subteam_id}:${leg.station_id}`)?.code;
        const equipNow = stationCapAt(station, date, nowMin);
        // 设备整窗不可用 → 运营层取舍（已由 tradeoff 说明），不是安全问题。
        if (reason === "equipment_unavailable" || equipNow <= 0) continue;
        // 站可运行却落空：高风险必须有人指导，缺讲师即升级。
        escalations.push(this._openEscalation(groupId, leg, station, "高风险环节重排后无合格讲师可用", date, nowMin));
      }
      for (const t of proposal.tradeoffs) {
        if (t.risk_level === "high" && t.code === "instructor_unavailable" &&
            !escalations.some((e) => e.subteam_id === t.subteam_id && e.station_id === t.station_id) &&
            !openSame(t.station_id, t.subteam_id)) {
          const station = this.store.state.stations.get(t.station_id);
          escalations.push(this._openEscalation(groupId, { subteam_id: t.subteam_id, station_id: t.station_id, start: null, end: null }, station, t.reason, date, nowMin));
        }
      }

      const holdId = id("hold");
      this._append("ROUTE_REPLANNED", groupId, {
        hold_id: holdId,
        replan: {
          group_id: groupId,
          reason: input.reason ?? "manual",
          at_minute: nowMin,
          proposal,
          kept_leg_ids: frozen.filter((l) => !l.interrupted).map((l) => l.leg_id),
          interrupted_leg_ids: interruptedHighRisk.map((l) => l.leg.leg_id),
          escalation_ids: escalations.map((e) => e.escalation_id),
        },
      });

      return { ...this._itineraryView(groupId), escalations };
    });
  }

  // 馆方对高风险升级件裁决。
  decideEscalation(escalationId, token, decision) {
    return this._command(() => {
      this._requireMuseum(token);
      const esc = this.store.state.escalations.get(escalationId);
      if (!esc) throw new ServiceError("unknown_escalation", "升级件不存在");
      if (esc.status !== "open") throw new ServiceError("already_resolved", "升级件已裁决");

      const group = this._requireGroup(esc.group_id);
      const it = this.store.state.itineraries.get(esc.group_id);
      const date = it?.proposal.date ?? group.visit_date;
      const nowMin = decision.at_minute ?? this._deriveNowMin(group);

      if (decision.decision === "assign_instructor") {
        const ins = this.store.state.instructors.get(decision.instructor_id);
        if (!ins) throw new ServiceError("unknown_instructor", "讲师不存在");
        const station = this.store.state.stations.get(esc.station_id);
        const qualified = ins.qualifications.includes("any") ||
          ins.qualifications.includes(station.id) ||
          station.tags.some((tag) => ins.qualifications.includes(tag));
        if (!qualified) throw new ServiceError("not_qualified", "该讲师不具备此高风险站点/工种资格");
        this._append("HIGH_RISK_DECIDED", escalationId, {
          escalation_id: escalationId,
          decision: "assign_instructor",
          resolution: { instructor_id: ins.id, note: decision.note ?? "" },
        });
        // 释放中断冻结，带着强制讲师重新规划（既往裁决一并保留）。
        this._releaseInterrupted(esc.group_id, esc);
        let view = this._replanAfterDecision(esc.group_id, date, nowMin);
        // 新讲师可能顺带满足了其他待决升级件：核对后自动关闭。
        this._autoResolveSatisfied(esc.group_id, view, date, nowMin);
        view = this._itineraryView(esc.group_id);
        // 校验裁决是否真正落地：派了人却排不进去（人数超设备、窗内无时段），
        // 必须重新升级告知馆方，不能假装闭环。
        if (!this._decisionLanded(esc.group_id, esc.station_id, esc.subteam_id)) {
          const reopened = this._openEscalation(
            esc.group_id,
            { subteam_id: esc.subteam_id, station_id: esc.station_id, start: nowMin, end: null },
            this.store.state.stations.get(esc.station_id),
            `已指派讲师 ${decision.instructor_id}，但该子队在剩余窗内无法排入（设备容量/时长/无障碍工位限制），请调整分组或改期`,
            date, nowMin,
          );
          view = { ...view, escalations: [...view.escalations, {
            escalation_id: reopened.escalation_id, station_id: esc.station_id, subteam_id: esc.subteam_id,
            reason: reopened.reason, status: "open", decision: null,
          }] };
        }
        return view;
      }

      if (decision.decision === "cancel_leg") {
        this._append("HIGH_RISK_DECIDED", escalationId, {
          escalation_id: escalationId,
          decision: "cancel_leg",
          resolution: { reason: decision.reason ?? "instructor_absent", note: decision.note ?? "" },
        });
        this._append("PROGRESS_REPORTED", esc.group_id, {
          group_id: esc.group_id,
          station_id: esc.station_id,
          subteam_id: esc.subteam_id,
          status: PROGRESS_STATUS.SKIPPED,
          reason: "instructor_absent",
          at_minute: nowMin,
          note: "馆方裁决取消该高风险环节，全程未安排无人指导",
        });
        this._releaseInterrupted(esc.group_id, esc);
        this._replanAfterDecision(esc.group_id, date, nowMin);
        return this._itineraryView(esc.group_id);
      }

      throw new ServiceError("bad_decision", "decision 须为 assign_instructor 或 cancel_leg");
    });
  }

  // —— 事后核对 ——

  // 馆方发起核对：系统由计划 + 实际进度 + 设备异常归约出逐条结果。
  museumReconcile(groupId, token, { museum_note = "" } = {}) {
    return this._command(() => {
      this._requireMuseum(token);
      const group = this._requireGroup(groupId);
      const it = this.store.state.itineraries.get(groupId);
      if (!it) throw new ServiceError("no_itinerary", "该团队无行程记录");
      const date = it.proposal.date;
      const actuals = this.store.state.actuals.get(groupId) ?? [];
      const lastActual = new Map();
      for (const a of actuals) {
        lastActual.set(`${a.subteam_id ?? ""}:${a.station_id}`, a);
      }

      const items = [];
      const seen = new Set();
      for (const leg of it.proposal.legs) {
        const key = `${leg.subteam_id}:${leg.station_id}`;
        seen.add(key);
        const station = this.store.state.stations.get(leg.station_id);
        const actual = lastActual.get(key);
        const anomalies = (station.equipment_events ?? [])
          .filter((e) => (!e.date || e.date === date) && e.status !== EQUIPMENT_STATUS.OPERATIONAL)
          .map((e) => ({ status: e.status, from_min: e.from_min, note: e.note }));
        items.push({
          station_id: leg.station_id,
          station_name: station?.name ?? leg.station_id,
          subteam_id: leg.subteam_id,
          planned: { start: leg.start, end: leg.end, instructor_id: leg.instructor_id, risk_level: leg.risk_level },
          actual_status: actual?.status ?? (leg.actual_status ?? "not_reported"),
          skip_reason: actual?.reason ?? null,
          equipment_anomalies: anomalies,
          supervised: !(station?.risk_level === "high") || Boolean(leg.instructor_id),
        });
      }
      // 被跳过而未进入最终方案的计划环节（历史版本中出现过）。
      for (const old of it.history ?? []) {
        for (const leg of old.legs ?? []) {
          const key = `${leg.subteam_id}:${leg.station_id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const actual = lastActual.get(key);
          if (actual?.status === "completed") continue;
          items.push({
            station_id: leg.station_id,
            station_name: this.store.state.stations.get(leg.station_id)?.name ?? leg.station_id,
            subteam_id: leg.subteam_id,
            planned: { start: leg.start, end: leg.end, instructor_id: leg.instructor_id, risk_level: leg.risk_level },
            actual_status: actual?.status ?? "dropped_from_final_plan",
            skip_reason: actual?.reason ?? "capacity_conflict",
            equipment_anomalies: [],
            supervised: true,
          });
        }
      }

      this._append("VISIT_RECONCILED", groupId, { group_id: groupId, items, museum_note });
      return { group_id: groupId, items, museum_note };
    });
  }

  schoolConfirmReconciliation(groupId, token, { accepted, items = [], note = "" }) {
    return this._command(() => {
      const group = this._requireGroup(groupId);
      this._requireTeacher(group, token);
      const rec = this.store.state.reconciliations.get(groupId);
      if (!rec) throw new ServiceError("no_reconciliation", "馆方尚未发起核对");
      this._append("RECONCILIATION_CONFIRMED", groupId, { group_id: groupId, accepted, items, note });
      return this.store.state.reconciliations.get(groupId);
    });
  }

  // —— 视图 ——

  // 馆方：某日整体拥堵/闲置、通道负载、在馆团队与待裁决升级件。
  museumView(date, token, { nowMin = null } = {}) {
    this._requireMuseum(token);
    const state = this.store.state;
    const occ = buildOccupancy(state, date);
    // 利用率口径：当日在馆团队窗口的并集跨度。
    const dayGroups = [...state.groups.values()].filter((g) => g.visit_date === date);
    let spanStart = null;
    let spanEnd = null;
    for (const g of dayGroups) {
      spanStart = spanStart == null ? g.window.start_min : Math.min(spanStart, g.window.start_min);
      spanEnd = spanEnd == null ? g.window.end_min : Math.max(spanEnd, g.window.end_min);
    }
    const openMin = spanStart != null ? Math.max(1, spanEnd - spanStart) : 1;
    const stations = [...state.stations.values()].map((st) => {
      const perMin = occ.stationMin.get(st.id);
      let peak = 0;
      let busyMin = 0;
      const blocked = occ.blockedMin.get(st.id)?.size ?? 0;
      for (const [m, v] of perMin ?? []) {
        if (m < spanStart || m >= spanEnd) continue;
        peak = Math.max(peak, v.people);
        if (v.people > 0) busyMin += 1;
      }
      return {
        station_id: st.id,
        name: st.name,
        zone: st.zone,
        risk_level: st.risk_level,
        equipment_status: nowMin == null ? st.equipment_status : equipmentStatusAt(st, date, nowMin),
        safety_capacity: st.safety_capacity,
        devices: st.devices,
        accessible_bays: st.accessible_bays,
        peak_people: peak,
        utilization: Number((busyMin / openMin).toFixed(2)),
        changeover_minutes: blocked,
        idle: busyMin === 0,
        congested: peak >= st.safety_capacity,
      };
    });
    const corridors = [...state.corridors.values()].map((c) => {
      let peak = 0;
      for (const v of occ.corridorMin.get(c.id)?.values() ?? []) peak = Math.max(peak, v.people);
      return { corridor_id: c.id, name: c.name, capacity: c.capacity, peak_people: peak, congested: peak >= c.capacity };
    });
    const groups = [...state.groups.values()]
      .filter((g) => g.visit_date === date)
      .map((g) => ({ group_id: g.id, school_name: g.school_name, party_size: g.party_size, status: state.itineraries.get(g.id)?.status ?? "none" }));
    const escalations = [...state.escalations.values()].filter((e) => e.status === "open");
    return { date, now_min: nowMin, stations, corridors, groups, open_escalations: escalations };
  }

  // 老师：仅本团队的实时行程（凭 token 隔离），含进行到第几分钟、取舍与升级。
  teacherView(groupId, token, { nowMin = null } = {}) {
    const group = this._requireGroup(groupId);
    this._requireTeacher(group, token);
    return this._itineraryView(groupId, { nowMin });
  }

  _itineraryView(groupId, { nowMin = null } = {}) {
    const it = this.store.state.itineraries.get(groupId);
    const group = this.store.state.groups.get(groupId);
    if (!it) return { group_id: groupId, school_name: group?.school_name ?? null, status: "none" };
    const escs = [...this.store.state.escalations.values()].filter((e) => e.group_id === groupId);
    const legs = it.proposal.legs.map((l) => {
      const st = this.store.state.stations.get(l.station_id);
      let phase = "planned";
      if (l.actual_status === "completed") phase = "completed";
      else if (l.actual_status === "skipped") phase = "skipped";
      else if (l.interrupted) phase = "interrupted";
      else if (l.actual_status === "arrived") phase = "in_progress";
      else if (nowMin != null && l.start <= nowMin && nowMin < l.end) phase = "due";
      return {
        ...l,
        station_name: st?.name ?? l.station_id,
        zone: st?.zone,
        instructor_name: l.instructor_id ? this.store.state.instructors.get(l.instructor_id)?.name ?? l.instructor_id : null,
        phase,
      };
    });
    return {
      group_id: groupId,
      school_name: group?.school_name ?? null,
      teacher_name: group?.teacher_name ?? null,
      status: it.status,
      expires_at: it.expires_at,
      date: it.proposal.date,
      window: it.proposal.window,
      subteams: it.proposal.subteams,
      legs: legs.sort((a, b) => a.start - b.start || a.subteam_id.localeCompare(b.subteam_id)),
      moves: it.proposal.moves ?? [],
      tradeoffs: it.proposal.tradeoffs ?? [],
      coverage: it.proposal.coverage ?? null,
      escalations: escs.map((e) => ({
        escalation_id: e.escalation_id, station_id: e.station_id, subteam_id: e.subteam_id,
        reason: e.reason, status: e.status, decision: e.decision ?? null,
      })),
      replan_count: (it.history ?? []).length,
    };
  }

  // —— 内部工具 ——

  _holdProposal(group, { trigger }) {
    const proposal = planVisit(this.store.state, group, { date: group.visit_date });
    const holdId = id("hold");
    const expires = new Date(this.now().getTime() + this.holdTtlMin * 60_000);
    this._append("ITINERARY_HELD", group.id, { hold_id: holdId, expires_at: expires.toISOString(), proposal, trigger });
    return { ...this._itineraryView(group.id), hold_id: holdId, expires_at: expires.toISOString() };
  }

  _sweepExpired() {
    const nowIso = this.now().toISOString();
    for (const [groupId, it] of this.store.state.itineraries) {
      if (it.status === "held" && it.expires_at && it.expires_at < nowIso) {
        this.store.append("HOLD_EXPIRED", groupId, { group_id: groupId, hold_id: it.hold_id });
      }
    }
  }

  _openEscalation(groupId, legRef, station, reason, date, nowMin) {
    const escalationId = id("esc");
    this._append("HIGH_RISK_ESCALATED", groupId, {
      escalation_id: escalationId,
      group_id: groupId,
      station_id: station.id,
      subteam_id: legRef.subteam_id ?? null,
      start: legRef.start ?? nowMin,
      end: legRef.end ?? null,
      reason,
      detail: `高风险站点 ${station.name}（${station.id}）缺少合格讲师现场指导，等待馆方人工裁决`,
      date,
    });
    return this.store.state.escalations.get(escalationId);
  }

  _decisionLanded(groupId, stationId, subteamId) {
    const it = this.store.state.itineraries.get(groupId);
    return it.proposal.legs.some(
      (l) => l.station_id === stationId && l.subteam_id === subteamId && Boolean(l.instructor_id),
    );
  }

  // 馆方为某工种批准讲师后，新方案可能用同一已批准讲师满足了其他子队的
  // 同类升级件——仅在此情况下随附关闭，并留下决策痕迹；其余升级件继续等待。
  _autoResolveSatisfied(groupId, view, date, nowMin) {
    const approvedInstructorsByStation = new Map();
    for (const e of this.store.state.escalations.values()) {
      if (e.group_id !== groupId || e.status !== "resolved" || e.decision !== "assign_instructor") continue;
      const list = approvedInstructorsByStation.get(e.station_id) ?? new Set();
      list.add(e.resolution.instructor_id);
      approvedInstructorsByStation.set(e.station_id, list);
    }
    for (const esc of this.store.state.escalations.values()) {
      if (esc.group_id !== groupId || esc.status !== "open") continue;
      const leg = view.legs.find((l) => l.station_id === esc.station_id && l.subteam_id === esc.subteam_id);
      if (!leg?.instructor_id) continue;
      const approved = approvedInstructorsByStation.get(esc.station_id);
      if (!approved?.has(leg.instructor_id)) continue;
      this._append("HIGH_RISK_DECIDED", esc.escalation_id, {
        escalation_id: esc.escalation_id,
        decision: "assign_instructor",
        resolution: {
          instructor_id: leg.instructor_id,
          note: `随附裁决：沿用馆方已为 ${esc.station_id} 批准的讲师 ${leg.instructor_id}`,
          cascaded: true,
        },
      });
    }
  }

  _releaseInterrupted(groupId, esc) {
    const it = this.store.state.itineraries.get(groupId);
    if (!it) return;
    for (const leg of it.proposal.legs) {
      if (leg.interrupted && leg.station_id === esc.station_id &&
          (!esc.subteam_id || leg.subteam_id === esc.subteam_id)) {
        leg.interrupted = false;
        leg.actual_status = "skipped"; // 决策前的中断段不算已完成；由后续重排补体验
        leg.actual_reason = "instructor_absent";
      }
    }
  }

  _replanAfterDecision(groupId, date, nowMin, extras = {}) {
    const group = this._requireGroup(groupId);
    const it = this.store.state.itineraries.get(groupId);
    const frozen = it.proposal.legs.filter((l) => l.actual_status === "completed" || l.actual_status === "arrived");
    const forceInstructors = extras.forceInstructors ??
      new Map(this.store.state.instructorAssignments.get(groupId) ?? []);
    const bans = extras.bans ??
      [...(this.store.state.stationBans.get(groupId) ?? [])].map((key) => {
        const [subteam_id, station_id] = key.split(":");
        return { subteam_id, station_id };
      });
    const proposal = planVisit(this.store.state, group, {
      date,
      subteams: it.proposal.subteams,
      excludeOwn: true,
      protectLegs: frozen,
      forceInstructors,
      bans,
      windowStart: Math.max(it.proposal.window.start_min, nowMin),
      windowEnd: it.proposal.window.end_min,
    });
    const holdId = id("hold");
    this._append("ROUTE_REPLANNED", groupId, {
      hold_id: holdId,
      replan: {
        group_id: groupId,
        reason: "high_risk_decision",
        at_minute: nowMin,
        proposal,
        kept_leg_ids: frozen.map((l) => l.leg_id),
      },
    });
    return this._itineraryView(groupId);
  }

  _instructorStillServes(leg, station, date, nowMin) {
    const ins = this.store.state.instructors.get(leg.instructor_id);
    if (!ins) return false;
    const qualified = ins.qualifications.includes("any") ||
      ins.qualifications.includes(station.id) ||
      station.tags.some((tag) => ins.qualifications.includes(tag));
    if (!qualified) return false;
    return !ins.absences.some((a) => {
      if (a.date && a.date !== date) return false;
      const from = a.from_min ?? -Infinity;
      const to = a.to_min ?? Infinity;
      return nowMin >= from && nowMin < to;
    });
  }

  _deriveNowMin(group) {
    // 缺省时钟：到访窗口开始后 20 分钟（演示/测试可显式传 now_min）。
    return group.window.start_min + 20;
  }

  _validateGroupPayload(p) {
    const g = p.group;
    if (!g?.id && !p.party_size) throw new ServiceError("bad_group", "缺少团队标识或人数");
    const win = p.visit_window ?? g?.window;
    if (!win || win.start_min == null || win.end_min == null) throw new ServiceError("bad_window", "缺少到馆窗口");
    if (win.end_min <= win.start_min) throw new ServiceError("bad_window", "窗口结束须晚于开始");
    if (!p.visit_date && !g?.visit_date) throw new ServiceError("bad_date", "缺少到访日期");
  }

  _requireGroup(groupId) {
    const g = this.store.state.groups.get(groupId);
    if (!g) throw new ServiceError("unknown_group", "团队不存在");
    return g;
  }

  _requireMuseum(token) {
    if (token !== this.museumToken) throw new ServiceError("unauthorized", "需要馆方凭证", { status: 403 });
  }

  _requireTeacher(group, token) {
    if (token !== group.teacher_token) throw new ServiceError("unauthorized", "老师只能查看/操作本团队", { status: 403 });
  }
}
