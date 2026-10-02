// 轮转规划器：根据学校需求与场馆实时资源生成轮换方案。
// 输出不仅是路线，还包含每条取舍说明（为何跳过、改时段或无法安排）。
//
// 调度模型：子队各自维护时间游标，按"最早空闲"依次落位；站点容量、
// 无障碍工位、讲师时间线、换场封锁与通道容量逐分钟校验，所有临时
// 落位即时计入占用图，因此先到先得且绝不超额。

import { buildOccupancy, checkLeg, checkMove, instructorCanServe } from "./capacity.js";

const OBJ_WEIGHT = { must: 100, want: 60, bonus: 20 };
const STEP_MIN = 5;

// —— 分组：按年龄段切分子队，超大班自动再切，陪同均摊，轮椅逐队轮转 ——
export function buildSubteams(group) {
  const teams = [];
  const cap = group.max_subteam_size ?? 16;
  const push = (students, minAge, maxAge) => {
    let remaining = Math.max(0, students);
    if (remaining === 0) return;
    while (remaining > 0) {
      const n = Math.min(cap, remaining);
      remaining -= n;
      teams.push({
        id: `T${teams.length + 1}`,
        students: n,
        chaperones: 0,
        size: n,
        age_min: minAge,
        age_max: maxAge,
        wheelchair_users: 0,
      });
    }
  };

  if (group.age_bands?.length) {
    for (const band of group.age_bands) push(band.students, band.min_age, band.max_age);
  } else {
    const students = Math.max(1, (group.party_size ?? 1) - (group.chaperones ?? 0));
    push(students, group.age_min ?? 6, group.age_max ?? 18);
  }
  if (!teams.length) push(1, 6, 18);

  let chaperones = group.chaperones ?? 0;
  let idx = 0;
  while (chaperones > 0) {
    teams[idx % teams.length].chaperones += 1;
    teams[idx % teams.length].size += 1;
    chaperones -= 1;
    idx += 1;
  }
  // 陪同入队后若超出单队上限，把超出的学生溢出为同年龄段的新队。
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    if (t.size <= cap) continue;
    const overflowStudents = t.size - cap;
    t.students -= overflowStudents;
    t.size = cap;
    teams.push({
      id: `T${teams.length + 1}`,
      students: overflowStudents,
      chaperones: 0,
      size: overflowStudents,
      age_min: t.age_min,
      age_max: t.age_max,
      wheelchair_users: 0,
    });
  }
  const w = group.accessibility_needs?.wheelchair_users ?? 0;
  for (let i = 0; i < w; i++) teams[i % teams.length].wheelchair_users += 1;
  return teams;
}

// 陪同人员/学生临时增减时，尽量沿用既有子队编号（已完成环节要挂得住）。
export function adjustSubteams(teams, { addChaperones = 0, addStudents = 0, addWheelchairUsers = 0, maxSize = 16 }) {
  const next = teams.map((t) => ({ ...t }));
  let i = 0;
  for (let k = 0; k < addChaperones; k++) {
    next[i % next.length].chaperones += 1;
    next[i % next.length].size += 1;
    i += 1;
  }
  let students = addStudents;
  while (students > 0) {
    const t = next[i % next.length];
    if (t.size < maxSize) {
      t.students += 1;
      t.size += 1;
      students -= 1;
    }
    i += 1;
    if (i > next.length * (maxSize + 1)) {
      next.push({ id: `T${next.length + 1}`, students: 0, chaperones: 0, size: 0, age_min: 6, age_max: 18, wheelchair_users: 0 });
      i = 0;
    }
  }
  for (let k = 0; k < addWheelchairUsers; k++) {
    next[k % next.length].wheelchair_users += 1;
  }
  return next;
}

function stationFitsTeam(station, team) {
  if (team.age_min < station.age_min || team.age_max > station.age_max) return false;
  if (team.wheelchair_users > (station.accessible_bays ?? 0)) return false;
  return true;
}

// 按场馆真实容量收紧子队：任何子队都不能大于其年龄段可进站点的最大
// 安全容量，轮椅队还要受无障碍工位约束；超限时整队拆小并重新编号。
// 仅在首次规划（无既有环节）时使用，重规划沿用原编号以免悬挂已完成环节。
export function fitSubteamsToVenue(state, teams) {
  const out = [];
  for (const t of teams) {
    const eligible = [...state.stations.values()].filter(
      (st) => t.age_min >= st.age_min && t.age_max <= st.age_max,
    );
    // 取可进站中的最小安全容量，保证拆出的每队都能轮转全部适龄站点。
    const caps = eligible
      .filter((st) => (st.accessible_bays ?? 0) >= (t.wheelchair_users > 0 ? 1 : 0))
      .map((st) => st.safety_capacity);
    const cap = caps.length ? Math.min(...caps) : 0;
    if (cap <= 0 || t.size <= cap) {
      out.push({ ...t, id: `T${out.length + 1}` });
      continue;
    }
    let students = t.students;
    let chaps = t.chaperones;
    const start = out.length;
    while (students + chaps > 0) {
      const takeStudents = Math.min(students, cap);
      const takeChaps = Math.min(chaps, Math.max(0, cap - takeStudents));
      if (takeStudents + takeChaps === 0) break;
      out.push({
        id: `T${out.length + 1}`,
        students: takeStudents,
        chaperones: takeChaps,
        size: takeStudents + takeChaps,
        age_min: t.age_min,
        age_max: t.age_max,
        wheelchair_users: 0,
      });
      students -= takeStudents;
      chaps -= takeChaps;
    }
    // 拆分后的子队逐队放置轮椅使用者（每队至多 1 人，匹配仅有 1 个无障碍工位的站点）。
    const pieces = out.slice(start);
    for (let k = 0; k < t.wheelchair_users; k++) {
      pieces[k % pieces.length].wheelchair_users += 1;
    }
  }
  return out;
}

function pickInstructor(state, occ, station, date, start, end) {
  for (const ins of [...state.instructors.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!instructorCanServe(state, ins, station, date, start, end)) continue;
    let busy = false;
    for (let m = start; m < end; m++) {
      if ((occ.instructorMin.get(ins.id)?.get(m) ?? 0) > 0) { busy = true; break; }
    }
    if (!busy) return ins.id;
  }
  return null;
}

function addLegTo(occ, leg, station) {
  for (let m = leg.start; m < leg.end; m++) {
    const per = occ.stationMin.get(station.id) ?? new Map();
    const cur = per.get(m) ?? { people: 0, wheelchair: 0 };
    cur.people += leg.size;
    cur.wheelchair_users = (cur.wheelchair_users ?? 0) + leg.wheelchair_users;
    per.set(m, cur);
    occ.stationMin.set(station.id, per);
  }
  if (!occ.blockedMin.has(station.id)) occ.blockedMin.set(station.id, new Set());
  for (let m = leg.end; m < leg.changeover_end; m++) occ.blockedMin.get(station.id).add(m);
  if (leg.instructor_id) {
    for (let m = leg.start; m < leg.end; m++) {
      const per = occ.instructorMin.get(leg.instructor_id) ?? new Map();
      per.set(m, (per.get(m) ?? 0) + 1);
      occ.instructorMin.set(leg.instructor_id, per);
    }
  }
}

function addMoveTo(occ, move) {
  for (let m = move.start; m < move.end; m++) {
    const per = occ.corridorMin.get(move.corridor_id) ?? new Map();
    const cur = per.get(m) ?? { people: 0 };
    cur.people += move.size;
    per.set(m, cur);
    occ.corridorMin.set(move.corridor_id, per);
  }
}

// 两站之间的移动通道：优先使用站点声明的 corridor_id，否则按分区匹配
// 连通两区的通道；轮椅需求只选无障碍通道。同区移动不需要通道。
function findCorridor(state, fromStation, toStation, accessible) {
  if (!fromStation || fromStation.zone === toStation.zone) return null;
  const connects = (c) =>
    c.connects_zones.length === 2 &&
    c.connects_zones.includes(fromStation.zone) && c.connects_zones.includes(toStation.zone);
  const usable = (c) => connects(c) && (!accessible || c.accessible);
  const preferred = [fromStation.corridor_id, toStation.corridor_id]
    .map((id) => (id ? state.corridors.get(id) : null))
    .find((c) => c && usable(c));
  if (preferred) return preferred;
  const hits = [...state.corridors.values()].filter(usable);
  return hits.sort((a, b) => a.travel_min - b.travel_min)[0] ?? null;
}

// 尝试在 start 时刻把队放入站；任何一项硬约束不满足即返回失败原因。
function tryPlace(state, date, occ, team, station, start, prevLeg, tradeoffSink, ctx) {
  const legSeq = ctx.legSeq;
  const end = start + station.duration_min;
  const chEnd = end + station.changeover_min;

  const corridor = prevLeg
    ? findCorridor(state, state.stations.get(prevLeg.station_id), station, team.wheelchair_users > 0)
    : null;
  const travel = corridor?.travel_min ?? 0;
  if (prevLeg && start - prevLeg.end < travel) return { ok: false, reason: "travel_time" };
  if (team.wheelchair_users > 0 && prevLeg && state.stations.get(prevLeg.station_id)?.zone !== station.zone && !corridor) {
    return { ok: false, reason: "no_accessible_route" };
  }

  const leg = {
    leg_id: `leg-${legSeq.n++}`,
    subteam_id: team.id,
    station_id: station.id,
    start,
    end,
    duration_min: station.duration_min,
    changeover_min: station.changeover_min,
    changeover_end: chEnd,
    size: team.size,
    wheelchair_users: team.wheelchair_users,
    risk_level: station.risk_level,
    instructor_id: null,
    actual_status: null,
  };

  if (station.requires_instructor || station.risk_level === "high") {
    const forcedKey = `${team.id}:${station.id}`;
    const forcedId = ctx.forceInstructors?.get(forcedKey);
    let insId = null;
    if (forcedId) {
      const forced = state.instructors.get(forcedId);
      if (instructorCanServe(state, forced, station, date, start, end)) {
        let busy = false;
        for (let m = start; m < end; m++) {
          if ((occ.instructorMin.get(forcedId)?.get(m) ?? 0) > 0) { busy = true; break; }
        }
        if (!busy) insId = forcedId;
      }
      if (!insId) return { ok: false, reason: "forced_instructor_unavailable" };
    } else {
      insId = pickInstructor(state, occ, station, date, start, end);
    }
    if (!insId) {
      tradeoffSink.push({
        code: "instructor_unavailable",
        station_id: station.id,
        subteam_id: team.id,
        risk_level: station.risk_level,
        reason: station.risk_level === "high"
          ? "高风险站点此刻无合格讲师，按安全红线不得无人指导，环节留空待馆方处理"
          : "暂无空闲且具备资格的讲师",
      });
      return { ok: false, reason: "instructor_unavailable" };
    }
    leg.instructor_id = insId;
  }

  const violations = checkLeg(state, date, leg, occ);
  if (violations.length) return { ok: false, reason: violations[0].type, violations };

  let move = null;
  if (corridor) {
    move = {
      move_id: `mv-${leg.leg_id}`,
      subteam_id: team.id,
      corridor_id: corridor.id,
      start: prevLeg.end,
      end: start,
      size: team.size,
      accessible_required: team.wheelchair_users > 0,
    };
    const mv = checkMove(state, date, move, occ);
    if (mv.length) return { ok: false, reason: mv[0].type, violations: mv };
  }

  addLegTo(occ, leg, station);
  if (move) addMoveTo(occ, move);
  return { ok: true, leg, move };
}

// 为单个队在其游标时刻尝试落位下一站；成功返回环节，失败返回原因列表。
function placeNext(state, date, occ, team, ctx) {
  const { winEnd, objectives, visited, usage } = ctx;
  const cursor = ctx.cursors.get(team.id);
  const prevLeg = ctx.prevLegs.get(team.id) ?? null;

  const candidates = [...state.stations.values()]
    .filter((st) => stationFitsTeam(st, team) && !visited.has(st.id) &&
      !(ctx.bans?.has(`${team.id}:${st.id}`)))
    .map((st) => {
      let score = 5;
      for (const tag of st.tags) {
        if (objectives.has(tag)) score += OBJ_WEIGHT[objectives.get(tag)] ?? OBJ_WEIGHT.want;
      }
      // 馆方显式裁决"为该子队在该站指派讲师"：最高排期优先，确保裁决落地。
      if (ctx.forceInstructors?.has(`${team.id}:${st.id}`)) score += 1000;
      score -= (usage.get(st.id) ?? 0) * 25; // 轮换均衡
      return { st, score };
    })
    .sort((a, b) => b.score - a.score);

  const blockedReasons = [];
  for (const { st } of candidates) {
    if (cursor + st.duration_min > winEnd) { blockedReasons.push({ st, reason: "window_closed" }); continue; }
    const sink = [];
    const r = tryPlace(state, date, occ, team, st, cursor, prevLeg, sink, ctx);
    if (r.ok) {
      ctx.legs.push(r.leg);
      if (r.move) ctx.moves.push(r.move);
      visited.add(st.id);
      usage.set(st.id, (usage.get(st.id) ?? 0) + 1);
      ctx.prevLegs.set(team.id, r.leg);
      ctx.cursors.set(team.id, r.leg.changeover_end);
      return { placed: true };
    }
    blockedReasons.push({ st, reason: r.reason, sink });
  }
  return { placed: false, blockedReasons };
}

/**
 * 公平轮转调度：每一步选择"已排环节数最少、游标最早"的队落位下一站，
 * 保证所有子队拿到第一轮体验后，才有人进入第二轮；某队持续无处可去则
 * 按 5 分钟推进其游标，超过宽限后退出并输出取舍说明。
 */
export function planVisit(state, group, opts = {}) {
  const date = opts.date ?? group.visit_date;
  const winStart = opts.windowStart ?? group.window.start_min;
  const winEnd = opts.windowEnd ?? group.window.end_min;
  const protectLegIds = (opts.protectLegs ?? []).map((l) => l.leg_id);
  const occ = buildOccupancy(state, date, {
    excludeGroupId: opts.excludeOwn ? group.id : null,
    keepLegIds: protectLegIds,
  });

  const rawSubteams = opts.subteams ?? buildSubteams(group);
  const subteams = opts.subteams ? rawSubteams : fitSubteamsToVenue(state, rawSubteams);
  const protect = new Map();
  for (const leg of opts.protectLegs ?? []) protect.set(leg.leg_id, leg);

  const objectives = new Map();
  for (const o of group.learning_objectives ?? []) objectives.set(o.tag, o.priority ?? "want");

  const ctx = {
    legs: [],
    moves: [],
    tradeoffs: [],
    legSeq: { n: (opts.protectLegs ?? []).reduce((m, l) => {
      const n = Number(String(l.leg_id).replace(/\D/g, ""));
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0) },
    usage: new Map(),
    winEnd,
    objectives,
    cursors: new Map(),
    prevLegs: new Map(),
    forceInstructors: opts.forceInstructors ?? null,
    bans: opts.bans ? new Set(opts.bans.map((b) => `${b.subteam_id}:${b.station_id}`)) : null,
  };

  const visitedByTeam = new Map();
  const failures = new Map();
  const done = new Set();
  const blockedByTeam = new Map();
  const frozenCount = new Map();

  // 轮椅/可选站少的队最先行动（最受限者优先选资源）。
  const eligibleCount = (team) =>
    [...state.stations.values()].filter((st) => stationFitsTeam(st, team)).length;
  const ordered = [...subteams].sort((a, b) => eligibleCount(a) - eligibleCount(b));

  for (const team of ordered) {
    const visited = new Set();
    visitedByTeam.set(team.id, visited);
    let cursor = Math.max(winStart, opts.earliest?.[team.id] ?? winStart);
    // 已完成环节标记占用经验；进行中的冻结环节决定游标起点。
    let lastFrozen = null;
    for (const leg of [...protect.values()].filter((l) => l.subteam_id === team.id)) {
      if (leg.actual_status === "completed") visited.add(leg.station_id);
      if (!leg.interrupted) frozenCount.set(team.id, (frozenCount.get(team.id) ?? 0) + 1);
      if (!leg.interrupted && (leg.actual_status === "arrived" || leg.start <= cursor)) {
        if (!lastFrozen || leg.end > lastFrozen.end) lastFrozen = leg;
      }
    }
    if (lastFrozen) {
      ctx.prevLegs.set(team.id, lastFrozen);
      cursor = Math.max(cursor, lastFrozen.changeover_end ?? lastFrozen.end);
    }
    ctx.cursors.set(team.id, cursor);
  }

  // 每轮给"已排环节最少 + 游标最早"的队安排下一站。
  const activeTeams = () => ordered.filter((t) => !done.has(t.id) && ctx.cursors.get(t.id) < winEnd);
  while (activeTeams().length) {
    const team = activeTeams()
      .map((t) => ({
        t,
        legs: ctx.legs.filter((l) => l.subteam_id === t.id).length + (frozenCount.get(t.id) ?? 0),
        cursor: ctx.cursors.get(t.id),
      }))
      .sort((a, b) => a.legs - b.legs || a.cursor - b.cursor)[0].t;

    const result = placeNext(state, date, occ, team, { ...ctx, visited: visitedByTeam.get(team.id) });
    if (result.placed) {
      failures.set(team.id, 0);
      continue;
    }
    blockedByTeam.set(team.id, result.blockedReasons);
    const next = ctx.cursors.get(team.id) + STEP_MIN;
    ctx.cursors.set(team.id, next);
    const f = (failures.get(team.id) ?? 0) + 1;
    failures.set(team.id, f);
    if (next >= winEnd || f * STEP_MIN > 45) done.add(team.id);
  }

  for (const team of ordered) {
    const blocked = blockedByTeam.get(team.id);
    if (blocked) diagnose(ctx.tradeoffs, team, blocked, state, date, winEnd, visitedByTeam.get(team.id));
  }

  // 保留环节（已完成/进行中）原样进入新方案。
  const frozenLegs = [...protect.values()]
    .filter((l) => !l.interrupted)
    .sort((a, b) => a.start - b.start || a.subteam_id.localeCompare(b.subteam_id));
  const legs = [...frozenLegs, ...ctx.legs].sort((a, b) => a.start - b.start || a.subteam_id.localeCompare(b.subteam_id));

  const coverage = buildCoverage(objectives, legs, state);
  return {
    group_id: group.id,
    date,
    window: { start_min: winStart, end_min: winEnd },
    subteams,
    legs,
    moves: ctx.moves,
    tradeoffs: dedupeTradeoffs(ctx.tradeoffs),
    coverage,
  };
}

// 队时间用尽仍未体验的站点，给出最具解释力的取舍说明。
function diagnose(tradeoffs, team, blockedReasons, state, date, winEnd, visited) {
  const seen = new Set();
  for (const { st, reason, sink } of blockedReasons) {
    if (visited.has(st.id) || seen.has(st.id)) continue;
    seen.add(st.id);
    let code = reason;
    let detail = "";
    if (reason === "window_closed") {
      code = "window_closed";
      detail = `到馆窗口在 ${winEnd} 分钟结束前无法完成 ${st.duration_min} 分钟体验`;
    } else if (reason === "equipment_unavailable") {
      code = "equipment_unavailable";
      detail = "设备校准或故障";
    } else if (reason === "instructor_unavailable") {
      code = "instructor_unavailable";
      detail = st.risk_level === "high" ? "高风险环节无合格讲师，未自动安排" : "无可用合格讲师";
    } else if (reason === "station_over_capacity" || reason === "accessible_bay_exceeded") {
      code = "capacity_full";
      detail = reason === "accessible_bay_exceeded" ? "无障碍工位已被占满" : "剩余窗内安全容量/设备已满";
    } else if (reason === "changeover_conflict") {
      code = "changeover_conflict";
      detail = "换场时间与其他团队冲突";
    } else if (reason === "travel_time" || reason === "no_accessible_route") {
      detail = reason === "no_accessible_route" ? "两区间无无障碍通道" : "换场与通行时间不足";
    } else {
      detail = `受限于: ${reason}`;
    }
    tradeoffs.push({ code, station_id: st.id, subteam_id: team.id, risk_level: st.risk_level, reason: detail });
    for (const t of sink ?? []) tradeoffs.push(t);
  }
}

function buildCoverage(objectives, legs, state) {
  const tagsHit = new Set();
  for (const leg of legs) {
    const st = state.stations.get(leg.station_id);
    for (const t of st?.tags ?? []) tagsHit.add(t);
  }
  return {
    total_legs: legs.length,
    distinct_stations: new Set(legs.map((l) => l.station_id)).size,
    objectives: [...objectives.entries()].map(([tag, priority]) => ({
      tag,
      priority,
      satisfied: tagsHit.has(tag),
    })),
  };
}

function dedupeTradeoffs(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const key = `${t.code}|${t.station_id}|${t.subteam_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
