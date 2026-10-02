// 容量内核：以分钟为粒度统计站点（含换场）、无障碍工位、讲师时间线
// 与通道的占用，任何暂存/确认/重规划写入前都必须通过这里的校验。

import { EQUIPMENT_STATUS } from "./domain.js";
import { liveLegs } from "./store.js";

// 计算某一时刻站点的设备状态（支持带时间窗的校准/故障事件）。
export function equipmentStatusAt(station, date, minute) {
  let status = station.equipment_status;
  let latest = -1;
  for (const ev of station.equipment_events) {
    if (ev.date && ev.date !== date) continue;
    if (ev.from_min == null || minute < ev.from_min) continue;
    if (ev.to_min != null && minute >= ev.to_min) continue;
    if (ev.from_min >= latest) {
      status = ev.status;
      latest = ev.from_min;
    }
  }
  return status;
}

// 该分钟可承载的体验人数：受安全容量与"可用设备 × 单设备人数"双重约束。
export function stationCapAt(station, date, minute) {
  if (equipmentStatusAt(station, date, minute) !== EQUIPMENT_STATUS.OPERATIONAL) return 0;
  return Math.min(station.safety_capacity, station.devices * station.people_per_device);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// 汇总某日所有"仍生效"环节的占用。
// excludeGroupId + keepLegIds：重规划时排除该团队即将被替换的旧环节，
// 但保留其已到场/进行中的冻结环节。
export function buildOccupancy(state, date, { excludeGroupId = null, keepLegIds = null } = {}) {
  const keep = keepLegIds ? new Set(keepLegIds) : null;
  const stationMin = new Map(); // station -> minute -> {people, wheelchair}
  const blockedMin = new Map(); // station -> Set(minute) 换场硬封锁
  const instructorMin = new Map(); // instructor -> minute -> [{group, station}]
  const corridorMin = new Map(); // corridor -> minute -> {people, wheelchair}

  const add = (map, key, minute, delta) => {
    if (!map.has(key)) map.set(key, new Map());
    const per = map.get(key);
    per.set(minute, (per.get(minute) ?? 0) + delta);
  };
  const addObj = (map, key, minute, patch) => {
    if (!map.has(key)) map.set(key, new Map());
    const per = map.get(key);
    const cur = per.get(minute) ?? { people: 0, wheelchair: 0 };
    cur.people += patch.people ?? 0;
    cur.wheelchair += patch.wheelchair ?? 0;
    per.set(minute, cur);
  };

  for (const { leg, itinerary } of liveLegs(state, { date })) {
    if (excludeGroupId && itinerary.proposal.group_id === excludeGroupId && !(keep && keep.has(leg.leg_id))) continue;
    const chEnd = leg.changeover_end ?? leg.end + (leg.changeover_min ?? 0);
    for (let m = leg.start; m < leg.end; m++) {
      addObj(stationMin, leg.station_id, m, { people: leg.size, wheelchair: leg.wheelchair_users ?? 0 });
    }
    if (!blockedMin.has(leg.station_id)) blockedMin.set(leg.station_id, new Set());
    for (let m = leg.end; m < chEnd; m++) blockedMin.get(leg.station_id).add(m);

    if (leg.instructor_id) {
      for (let m = leg.start; m < leg.end; m++) add(instructorMin, leg.instructor_id, m, 1);
    }
  }

  for (const it of state.itineraries.values()) {
    if (it.status !== "held" && it.status !== "accepted") continue;
    if (it.proposal.date !== date) continue;
    // 重规划团队的旧移动整体作废（冻结环节为已到场/进行中，其移动已发生）。
    if (excludeGroupId && it.proposal.group_id === excludeGroupId) continue;
    for (const mv of it.proposal.moves ?? []) {
      for (let m = mv.start; m < mv.end; m++) {
        addObj(corridorMin, mv.corridor_id, m, { people: mv.size, wheelchair: mv.accessible_required ? 1 : 0 });
      }
    }
  }

  return { stationMin, blockedMin, instructorMin, corridorMin };
}

// 讲师在时间窗内是否可指导该站：资格按站点/工种匹配（站点 id 或其标签），
// "any" 为全场巡场资格；高风险通配不等于跨工种资格。
export function instructorCanServe(state, instructor, station, date, start, end) {
  if (!instructor) return false;
  const qualified =
    instructor.qualifications.includes("any") ||
    instructor.qualifications.includes(station.id) ||
    station.tags.some((tag) => instructor.qualifications.includes(tag));
  if (!qualified) return false;
  return !instructor.absences.some((a) => {
    if (a.date && a.date !== date) return false;
    const from = a.from_min ?? -Infinity;
    const to = a.to_min ?? Infinity;
    return overlaps(start, end, from, to);
  });
}

// 校验单个待写入环节（可选占用图，缺省实时构建）。
// ignoreLegIds 用于重规划时排除即将被替换的旧环节。
export function checkLeg(state, date, candidate, occ = buildOccupancy(state, date), { ignoreLegIds = null } = {}) {
  const violations = [];
  const station = state.stations.get(candidate.station_id);
  if (!station) {
    violations.push({ type: "station_missing", station_id: candidate.station_id });
    return violations;
  }

  const chEnd = candidate.changeover_end ?? candidate.end + (candidate.changeover_min ?? station.changeover_min ?? 0);

  for (let m = candidate.start; m < candidate.end; m++) {
    const cap = stationCapAt(station, date, m);
    if (cap <= 0) {
      violations.push({ type: "equipment_unavailable", station_id: station.id, minute: m, status: equipmentStatusAt(station, date, m) });
      break;
    }
    const used = occ.stationMin.get(station.id)?.get(m);
    const people = (used?.people ?? 0) + candidate.size;
    const wheelchair = (used?.wheelchair ?? 0) + (candidate.wheelchair_users ?? 0);
    if (people > cap) violations.push({ type: "station_over_capacity", station_id: station.id, minute: m, used: people, cap });
    if (wheelchair > (station.accessible_bays ?? 0)) {
      violations.push({ type: "accessible_bay_exceeded", station_id: station.id, minute: m, used: wheelchair, bays: station.accessible_bays });
    }
    if (violations.some((v) => v.minute === m)) break;
  }

  for (let m = candidate.end; m < chEnd; m++) {
    if (occ.blockedMin.get(station.id)?.has(m)) {
      violations.push({ type: "changeover_conflict", station_id: station.id, minute: m });
      break;
    }
  }
  // 换场区也不能压住别人正在进行的体验（由 stationMin 在换场分钟上自然检查新环节 start 即可，
  // 这里再防一手：新环节开始时站点是否处于别人的换场封锁）。
  if (occ.blockedMin.get(station.id)?.has(candidate.start)) {
    violations.push({ type: "changeover_conflict", station_id: station.id, minute: candidate.start });
  }

  if (station.requires_instructor || station.risk_level === "high") {
    if (!candidate.instructor_id) {
      violations.push({ type: "instructor_required", station_id: station.id, risk_level: station.risk_level });
    } else {
      const ins = state.instructors.get(candidate.instructor_id);
      if (!instructorCanServe(state, ins, station, date, candidate.start, candidate.end)) {
        violations.push({ type: "instructor_not_eligible", station_id: station.id, instructor_id: candidate.instructor_id });
      }
      for (let m = candidate.start; m < candidate.end; m++) {
        if ((occ.instructorMin.get(candidate.instructor_id)?.get(m) ?? 0) > 0) {
          violations.push({ type: "instructor_double_booked", station_id: station.id, instructor_id: candidate.instructor_id, minute: m });
          break;
        }
      }
    }
  }

  return violations;
}

export function checkMove(state, date, move, occ = buildOccupancy(state, date)) {
  const corridor = state.corridors.get(move.corridor_id);
  if (!corridor) return [{ type: "corridor_missing", corridor_id: move.corridor_id }];
  const violations = [];
  for (let m = move.start; m < move.end; m++) {
    const used = occ.corridorMin.get(corridor.id)?.get(m);
    const people = (used?.people ?? 0) + move.size;
    if (people > corridor.capacity) {
      violations.push({ type: "corridor_over_capacity", corridor_id: corridor.id, minute: m, used: people, cap: corridor.capacity });
      break;
    }
  }
  if (move.accessible_required && !corridor.accessible) {
    violations.push({ type: "corridor_not_accessible", corridor_id: corridor.id });
  }
  return violations;
}
