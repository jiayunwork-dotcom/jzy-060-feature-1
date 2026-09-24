# 运维实时监控仪表板（Real-time Ops Dashboard）

浏览器内的实时监控与历史回放仪表板。后端（Node.js 20 + Fastify + WebSocket）**每秒主动**把多路系统/业务指标推给前端（React + TypeScript + Vite），所有数据点在后端留档 24 小时，支持阈值告警（警告 / 严重两级）、可拖拽布局持久化、区间历史回放（暂停 / 2x / 5x 变速）、数据源采集开关管理，以及**用户自定义的“算出来的指标”（派生指标）**——它与原始采集指标是一等公民：能实时看曲线、能设告警、能进历史回放、能在数据源页统一管理。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 实时推送 | 服务端通过 **一条 WebSocket 长连接** 每秒主动推送，非前端轮询；自动重连 |
| 多路指标 | 系统：CPU、内存、网络吞吐；业务：每秒请求数、在线人数、错误率 |
| 派生指标 | 用户定义计算式（四则运算/括号/常数、引用原始或其它派生指标、窗口聚合 avg/max/min/last），按依赖拓扑序实时算出，支持增删改，定义持久化 |
| 图表 | 折线趋势（最近 5 分钟）、SVG 圆形仪表盘（瞬时值+阈值刻度）、柱状横向对比（原始与派生同框，派生以紫色区分） |
| 可布局 | react-grid-layout 拖拽换位 / 拉伸改大小，布局防抖保存到后端，下次进入自动恢复 |
| 告警 | 规则增删改；`> >= < <=` 阈值 + 警告/严重两级；原始与派生指标均可绑定；触发图表变色、横幅与桌面弹窗，回落自动解除 |
| 历史回放 | 选时间区间，取自后端 24h 真实留档（绝不现场重造），派生指标回放的是它当初逐点留存的真实序列；暂停 / 继续 / 1x 2x 5x / 拖动进度 |
| 数据源管理 | 集中查看源列表、正常/异常状态、最近数据点时间，手动开关采集（关闭即不再产点），并在同页管理派生指标定义 |
| 持久化 | 历史点（JSONL）、数据源开关、告警规则、**派生指标定义**、用户布局均落盘到容器卷 `/app/data` |

## 派生指标（算出来的指标）

- **计算式**：四则运算 `+ - * /`、括号、常数；可裸引用任意指标 id（原始或派生），如 `error_rate / 100`、`(cpu + memory) / 2`、`rps / online`。
- **窗口滚动聚合**：`avg(指标, 时长)`、`max(...)`、`min(...)`、`last(...)`，时长单位 `ms / s（默认）/ m / h`，如“最近五分钟错误率的平均”写作 `avg(error_rate, 5m)`。
- **多层依赖**：系统自动构建依赖图并做拓扑排序，每拍先算被依赖者、再算依赖者；派生指标也能被其它派生指标引用与窗口聚合。
- **环在保存时即被拒绝**：自环、双元环、更长链环都在保存那一刻挡下，并在错误信息里清楚列出是哪几个指标绕成了环，绝不混进运行时。
- **坏算式 / 未知引用 / 被零除不崩**：语法错误、引用不存在的指标在定义阶段拒绝；运行期被零除、依赖本拍无数据、结果非有限数，只把**这一路**单独标记为异常（页面给出可读原因），不连累其它指标。
- **不拿旧值凑算的明确约定**：某派生指标依赖的原始源被手动关闭或暂时取不到数时，该路（及其下游）**立即标记异常并停止产点**，WS 不推旧值、历史不补旧点、绑定它的激活告警立即解除；源恢复产出后自动恢复正常。
- **历史可回放且与实时一致**：派生点与原始点一样逐点写入 24h JSONL 留档，回放直接取它自己当时的真实序列，稳定可复现；重启后定义与历史都还在。定义被修改时，旧历史点作为“当时按旧定义产出的结果”冻结保留，新定义从此刻的新拍生效。

## 快速开始

### Docker（推荐，前后端一起拉起）

```bash
docker compose up -d --build
# 浏览器打开 http://localhost:8080
# 接口前缀 http://localhost:8080/api，WebSocket 路径 /api/ws
```

容器内跑自动化测试：

```bash
docker compose exec dashboard npm run test --workspace server
```

### 本地开发

```bash
npm install                      # 安装两个 workspace 的依赖
npm run dev:server               # 后端 http://127.0.0.1:8080 （tsx 热更新）
npm run dev:web                  # 前端 http://127.0.0.1:5173 （/api 与 ws 代理到 8080）
```

### 生产模式（本机）

```bash
npm run build                    # 构建前端(vite) 与后端(tsc)
npm start                        # 启动一体化服务，访问 http://localhost:8080
```

### 自动化测试（不开浏览器，黑盒打后端接口）

```bash
npm run build --workspace server
npm test                         # vitest：以子进程拉起真实服务，打 HTTP + WebSocket
```

测试通过环境变量 `ENABLE_TEST_API=true` 开启仅测试用的确定性注入/淘汰接口（`/api/test/*`，生产编排中为 `false`），因此无需等待随机模拟时序即可精确锁定行为。

## 被自动化测试锁定的行为

**原有能力（保持不回退）：**

1. **数据源开关**（`tests/sources.test.ts`）：手动关闭后该源不再新增数据点（历史最新时间戳停滞、WS 不再推送），重新打开后恢复推送；开关持久化。
2. **告警触发/回落与级别**（`tests/alerts.test.ts`）：越过阈值产生对应 `warning` / `critical` 告警事件，回落后产生 `resolved` 并从激活列表移除。
3. **阈值改动即时生效**（同上）：同一规则改阈值后，立即用最近一个**真实**值按新阈值重判，无需等新点。
4. **回放真实性**（`tests/history.test.ts`）：注入带独特取值的点后按区间查询，逐点比对 ts/value，区间外的点不混入，重复查询结果稳定（非现场重造）。
5. **24 小时滚动淘汰**（`tests/retention.test.ts`）：越窗旧点被 `prune` 删除（计数可断言），内存、区间查询、压缩后的磁盘文件都只保留窗口内点，且操作幂等。
6. **服务端主动推送**（`tests/realtime.test.ts`）：建连即收快照；客户端不发任何请求也能持续收到多批 `metrics` 帧。

**派生指标（本次新增，均为不开浏览器、直接打后端 HTTP/WS 与计算逻辑的黑盒测试）：**

7. **多层依赖按拓扑序计算**（`tests/derivedCompute.test.ts`）：四层派生定义（错误比率 / CPU+内存综合水位 / 人均请求量 / 跨三者的综合分）逐拍与手工按式推算的结果逐值相等；派生点与原始点在同一批 WS `metrics` 帧推送；被零除只把该路及下游标异常、无关路照常，下一拍恢复。
8. **成环保存即被拒绝且不影响存量**（`tests/derivedCycle.test.ts`）：自环、双元环、更长链环都在保存一刻返回 400 与环上指标链路；引用不存在指标、坏算式同样 400；被拒后定义不增加，已有定义照常计算。
9. **窗口聚合告警的触发/回落/改阈值**（`tests/derivedAlerts.test.ts`）：对 `avg(error_rate, 5s)` 设阈值，喂入让窗口均值先越限再回落的数据点后，告警按聚合新值先 fired 后 resolved（脾气与原始指标一致）；改阈值立即按最近真实聚合值重判。
10. **依赖源关闭的异常约定与持久化**（`tests/derivedSources.test.ts`）：依赖的原始源关闭后该派生立即异常、不产新点、WS 不推旧值，无关派生照常；重新打开后自动恢复；定义与历史落盘，同目录重启后仍在并继续参与计算。

## 后端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/sources` | 数据源列表（定义、开关、ok/error 状态、最近点时间） |
| PUT | `/api/sources/:id/enabled` | 手动开/关采集，body `{ "enabled": false }` |
| GET/POST | `/api/derived` | 派生指标列表（运行态）/ 新建定义 |
| PUT/DELETE | `/api/derived/:id` | 修改（名字/单位/小数位/满量程/算式/说明）/ 删除；成环、坏算式、未知引用返回 400，被引用/有规则时删除返回 409 |
| GET/POST | `/api/alerts/rules` | 规则列表 / 新建（sourceId 可为原始或派生指标） |
| PUT/DELETE | `/api/alerts/rules/:id` | 修改（阈值/级别/运算符/启停/备注）/ 删除 |
| GET | `/api/alerts/active` | 当前激活告警 |
| GET | `/api/alerts/events` | 最近告警/解除事件 |
| GET | `/api/history?from&to&sources=a,b` | 区间回放，返回后端真实留存点（原始与派生通用） |
| GET/PUT | `/api/layout` | 读取 / 保存用户布局 |
| WebSocket | `/api/ws` | 建连下发 `snapshot`，随后服务端推 `metrics` / `source` / `derived` / `alert_event` / `rules` |

## 目录结构（按职责拆分）

```
server/src/
  config.ts                 环境配置（节拍/保留窗口/数据目录）
  types.ts                  领域类型（含 DerivedDef / DerivedState）
  runtime.ts                装配：原始点留档/告警 -> 派生引擎拓扑计算 -> 推送 -> 淘汰
  derived/
    formula.ts              计算式词法/语法解析与求值（四则/括号/常数/引用/窗口聚合）
    graph.ts                依赖图、Kahn 拓扑排序、DFS 环检测、下游依赖者分析
    rollingWindow.ts        滚动窗口缓冲（半开区间 (t-w,t] 取值，二分+滚动淘汰）
    engine.ts               派生引擎：定义校验(语法/引用/环)、按拓扑序逐拍求值、
                            单路异常隔离、回填、留档与告警对接
  sources/
    defs.ts                 6 路指标定义
    registry.ts             数据源注册表（开关/状态）
    simulator.ts            高斯随机游走+日周期+偶发自愈故障的模拟采集
  storage/
    historyStore.ts         JSONL 留档、区间查询、24h 滚动淘汰与压缩（原始/派生通用）
    configStore.ts          开关/规则/派生定义/布局的原子化 JSON 持久化
  alerts/engine.ts          阈值判定、fired/resolved、改阈值即时重判、异常源失效
  realtime/hub.ts           WebSocket 连接管理与广播
  routes/                   sources / derived / alerts / history / layout / realtime / test
web/src/
  api/client.ts             REST 与 WS 封装
  store/useDashboard.ts     单条 WS 连接 + 5 分钟滑动窗口（原始+派生）+ 告警弹窗状态
  utils/metrics.ts          原始源/派生指标统一视图模型
  components/charts/        GaugeChart / TrendLine / CompareBars 三类图表（原始/派生通用）
  components/               DashboardGrid / AlertRulesPanel / DerivedPanel（派生增删改）
                            / AlertBanner / Toasts / ChartCard
  pages/                    DashboardPage / ReplayPage / SourcesPage
```

## 数据留存

- `data/history/<sourceId>.jsonl`：每行 `{ "ts", "value" }`，原始指标与派生指标各占一个文件，高频缓冲 2s 批量追加，淘汰时整文件压缩重写。
- `data/config.json`：数据源开关、告警规则、**派生指标定义**、布局（临时文件 + rename 原子写）。
- 保留窗口由 `HISTORY_RETENTION_MS`（默认 86400000 = 24h）控制，后台每分钟巡检淘汰。
