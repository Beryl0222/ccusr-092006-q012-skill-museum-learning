# 技能研学资源编排后端

面向世界技能博物馆研学高峰的资源编排服务：学校提交年龄结构、学习目标、到馆窗口、无障碍需求与可拆分范围；场馆持续维护互动站的设备数量、难度、讲师资格、换场时间与安全容量；系统生成**带取舍说明**的轮转方案，暂存名额到期自动释放，并发确认不突破任何站点、无障碍工位、讲师或通道上限。突发情况下保留已完成环节再调整剩余路线，**高风险体验绝不自动改成无人指导**。

零运行时依赖，仅用 Node.js 内置模块（`node:http`、`node:test`）。

## 它解决了带队老师最怕的事

- 抵达后才知道机器人设备在校准、木工讲师缺席、无障碍工位被别校占满、学生堵在通道里。
- 学校只需提交团队画像与到馆窗口；方案会说明**为什么**某些环节安排不上（窗口不足、设备校准、讲师无空档、无障碍工位满、两区间无无障碍通道）。
- 名额暂存 30 分钟（可配），逾期自动释放给其他学校；主动放弃立即释放。
- 设备故障、团队迟到、讲师缺席、陪同临时增加 → **保留已完成环节**，只重排剩余路线。
- 高风险站（机器人、木工机械）缺合格讲师时不会被静默降级为无人指导，而是生成**升级件**，由馆方显式裁决：指派**具备同工种资格**的讲师，或取消该队该环节并记录跳过原因。
- 馆方看到全馆拥堵/闲置、通道负载与待裁决升级件；老师凭独立令牌只能看到**本团队**的实时行程。
- 活动结束后双方核对实际体验、跳过原因与设备异常。

## 目录

```
src/
  domain.js    领域事件（18 种）、枚举与载荷校验
  store.js     事件溯源存储：所有状态由事件归约，写命令共用一把异步锁
  capacity.js  分钟级容量内核：站点/设备/无障碍工位/换场/讲师/通道
  planner.js   公平轮转规划器：按场馆容量拆队、最受限队优先、取舍说明
  service.js   应用服务：暂存/确认/重规划/升级裁决/视图/对账
  seed.js      虚构种子数据加载
  http.js      零依赖 HTTP 适配层（双令牌鉴权）
data/
  seed.json    虚构场馆（6 站、3 通道、5 讲师、2 所学校）
  sample.json  领域事件格式样例
scripts/
  demo.js      研学高峰当天端到端故事
tests/         30 项 node:test 测试（领域/容量/规划/服务/HTTP/并发）
```

## 快速开始

```bash
npm test          # 30 项测试
npm run demo      # 端到端剧情演示
npm start         # 启动 HTTP 服务（默认 8080，PORT 环境变量可改）
```

## HTTP API 速览

鉴权头：`X-Museum-Token: museum-demo-token`（馆方，可用 `MUSEUM_TOKEN` 覆盖）；老师用提交时获得的 `teacher_token` 放在 `X-Teacher-Token`。

### 场馆维护（馆方）
- `POST /museum/stations` 注册互动站：设备数、单机人数、安全容量、无障碍工位、时长、换场、风险等级、年龄与标签
- `PATCH /museum/stations/:id` 变更参数
- `POST /museum/stations/:id/equipment` 设备状态：`operational | calibrating | faulted`，可带 `date/from_min/to_min` 时间窗（校准期间分钟容量记 0）
- `POST /museum/instructors`、`POST /museum/instructors/:id/availability` 讲师建档（资格按站点 id 或工种标签）、到场/缺席时间窗
- `POST /museum/corridors` 通道建档：容量、是否无障碍、通行时长、连接分区
- `GET  /museum/view?date=YYYY-MM-DD` 全馆拥堵/闲置、通道峰值、在馆团队、待裁决升级件
- `POST /museum/groups/:id/replan` 馆方触发重规划（设备/讲师类突发）
- `POST /museum/escalations/:id/decide` 高风险裁决：`assign_instructor`（校验工种资格）或 `cancel_leg`
- `POST /museum/groups/:id/reconcile` 发起事后核对
- `GET  /museum/events` 审计事件流

### 学校/带队老师
- `POST /school/requests` 提交需求（响应含暂存方案、取舍说明、到期时间与 teacher_token）
- `GET  /school/groups/:id/itinerary` 仅本团队实时行程（进行到第几分钟可用 `?now_min=`）
- `POST /school/groups/:id/accept` / `/reject` 确认或放弃暂存
- `PATCH /school/groups/:id` 到访前需求变更
- `POST /school/groups/:id/progress` 回报 `arrived | completed | skipped`（跳过须给标准原因）
- `POST /school/groups/:id/replan` 团队迟到/陪同增加等触发重规划
- `POST /school/groups/:id/reconciliation/confirm` 核对结果确认

### 示例：学校提交

```bash
curl -s -X POST localhost:8080/school/requests \
  -H 'content-type: application/json' \
  -d '{
    "group": {"id":"grp-qihang","school_name":"上海市启航中学","teacher_name":"王老师"},
    "visit_date":"2026-10-15",
    "visit_window":{"start_min":540,"end_min":750},
    "learning_objectives":[{"tag":"robotics","priority":"must"},{"tag":"traditional-skills","priority":"want"}],
    "age_bands":[{"label":"初一","min_age":12,"max_age":13,"students":18}],
    "party_size":45,"chaperones":3,
    "accessibility_needs":{"wheelchair_users":2},
    "splittable":true
  }'
```

## 设计要点

**事件溯源 + 单写锁。** 全部状态由 18 种领域事件（`GROUP_REQUESTED`、`ITINERARY_HELD`、`HOLD_EXPIRED`、`ROUTE_REPLANNED`、`HIGH_RISK_ESCALATED/DECIDED`、`VISIT_RECONCILED` …）归约得到，可随时 `store.replay()` 审计。所有写命令进入同一把异步锁，进入时先清扫过期暂存——20 个并发确认在锁内逐个拿到包含前者占用的容量图，因此无需分布式锁也不会超额。

**分钟级容量内核。** 以分钟为单位同时校验：安全容量与 `设备数×单机人数` 取小、换场分钟硬封锁、无障碍工位数、讲师资格与时间线（不可同时带两场）、通道容量与无障碍可达性。校验失败返回结构化违例（`station_over_capacity`、`changeover_conflict`、`accessible_bay_exceeded`、`instructor_double_booked`、`corridor_over_capacity`…）。

**公平轮转。** 子队按年龄段切分后，再按"适龄可进站的最小安全容量"收紧（否则 16 人队永远进不了 8 人木工站）；轮椅使用者逐队分布（每队至多 1 人，匹配只有 1 个无障碍工位的站）。调度每一步选择"已排环节最少、游标最早"的队落位，最受限的队先选，保证所有队先拿到第一轮体验。

**重规划只动剩余路线。** `protectLegs` 中的已完成/进行中环节原样保留并继续占用资源，本团队旧方案的未来环节与移动整体作废后再排。团队迟到把所有队的起点移到实际到场时刻；陪同增加沿用原子队编号。

**安全红线。** `risk_level=high` 的站点在规划期就必须当场选定合格讲师（资格按站点或工种标签匹配，`high-risk` 这种风险等级**不是**跨工种通行证）；进行中的高风险环节讲师缺席，现场冻结并升级；馆方裁决结果（强制讲师/取消）以事件持久化，贯穿之后的每次重排；若裁决指派的人物理上排不进该队（人数超设备、窗内无时段），系统不会假装闭环，而是带着原因重新打开升级件。

**取舍说明。** 每队最终未体验的站点都会给出可解释原因（窗口结束、设备校准/故障、无合格讲师、容量/无障碍工位满、无无障碍通道、换场通行时间不足），而不是只给一个排不满的课表。

## 边界与后续

- 内存存储，重启不保留；事件流已结构化，接 Postgres/EventStoreDB 只需替换 `Store`。
- 时间粒度为分钟、以单日为范围；跨日活动需要扩展日期维度。
- 通道模型是"分区直连"，多跳路径与更真实的通道排队可在此基础上扩展。
- 讲师资格由馆方登记并在派单时强校验；真实系统应对接人员资质主数据。
