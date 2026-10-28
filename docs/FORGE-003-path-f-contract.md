# FORGE-003 · 路径 F 拉取 / 入库契约（v0.2 · 栈 X）

**Owner**：BOT-061  
**对齐**：FORGE-005（BOT-066）、FORGE-002 MOCK；调研依据 [`FORGE-003-huami-spike-notes.md`](./FORGE-003-huami-spike-notes.md)；机器可读 [`FORGE-003-openapi.yaml`](./FORGE-003-openapi.yaml) + [`FORGE-003-ingest-examples.json`](./FORGE-003-ingest-examples.json)  
**风险**：非官方私有云；ToS + 封号可能。Marco 经 Forge 书面接受（2026-10-28）。  
**密钥**：`userId` / `passToken` / `serviceToken` / `ssecurity` **禁止**写入 `/workspace`、git、群聊。仅 vault / 运行环境。

时区：业务日界 **Asia/Shanghai**；时间戳 ISO-8601 带 `+08:00` 或 epoch 秒，同一 payload 不混用。

---

## 0) 栈锁定（纠正 v0.1）

| | **栈 X（默认 · 本契约）** | 栈 H（对照 · 不做） |
|--|--------------------------|---------------------|
| App | 国行 **小米运动健康** | Zepp Life / 旧小米运动 |
| 云 | `hlth.io.mi.com` + STS `miothealth` | `api-mifit*.huami.com` + `apptoken` |
| 凭证 | `passToken` → `serviceToken` | `userid` + `apptoken`（~30d） |

Forge 票面「mifit/huami、apptoken」指栈 H；Marco 确认栈是小米运动健康 → **实现必须接栈 X**。混用会空数据或鉴权失败。

`devices.source` 建议枚举值：`mi_health`（替代草稿里的 `huami_mifit`）。

---

## 1) 组件边界

```
[小米手环] → [小米运动健康] → hlth.io.mi.com（加密私有 API）
                                    │
                         puller（BOT-061 契约 / 155 实现）
                         - vault 读凭证；STS 续期
                         - 日汇总 + 短窗采样 + 运动翻页
                         - 规范化 → 本契约 JSON
                                    │
                         POST /v1/ingest/batch
                                    │
                         Postgres（FORGE-005）幂等 upsert
                                    │
                         READ → FORGE-002（BOT-060）
```

官方隐私导出仍作 **回填**，不是日常路径。

---

## 2) 拉取策略（失败模式优先）

| 项 | 约定 |
|----|------|
| Transport | 栈 X：签名/RC4 封装在 puller；ingest **不**见密文上游 |
| 频率 | 日汇总 **每日 1 次**（建议 06:30 Asia/Shanghai）；原始 HR 短窗；运动 `limit=50` 翻页 |
| 间隔 | 请求 ≥1–2s + jitter；长窗分 chunk |
| 首桶丢失 | HR/calories 等：查询起点 **再提前 1 天**，本地裁剪（公开 notes/08） |
| 401 | 用 vault 内 `passToken` 续期 **最多 1 次**；仍 401 → `auth_expired`，停 |
| `70016` | `passToken` 废 → 告警人工重新扫码/登录（1:1，不进仓库） |
| 上游无 SLA | 5xx / 空 / 字段漂移 → `sync_run` failed/partial，不写半截日汇总 |

```json
{
  "sync_run_id": "uuid",
  "source": "mi_health",
  "started_at": "2026-10-28T06:30:00+08:00",
  "window": { "from": "2026-10-21", "to": "2026-10-28" },
  "result": "ok | partial | failed",
  "error_code": null,
  "upstream_status": 200
}
```

`error_code`：`auth_expired` | `pass_token_invalid` | `upstream_5xx` | `upstream_timeout` | `parse_error` | `rate_limited` | `incomplete_page` | `unknown`。

---

## 3) `POST /v1/ingest/batch`

```json
{
  "schema_version": "0.2",
  "device_id": "uuid-or-external",
  "source": "mi_health",
  "vendor_sid": "string|null",
  "sync_run_id": "uuid",
  "observed_at": "2026-10-28T06:31:00+08:00",
  "records": []
}
```

`device_id`：服务端 `devices.id`；首次可传 `external_id`=`vendor_sid` 或账号哈希占位，由 ingest 解析/建档。  
`vendor_sid`：上游 `sid`（可空；空则幂等退化为 account+type+time）。

### 3.1 `daily_summary` → `daily_aggregates`

| 契约字段 | 类型 | 上游（栈 X `daily_report`） | FORGE-002 |
|----------|------|---------------------------|-----------|
| `type` | const `daily_summary` | — | — |
| `day` | `YYYY-MM-DD` | 行 `time` → 本地日 | trends |
| `steps` | int | `steps.steps` | steps |
| `distance_m` | number | `steps.distance` | steps |
| `floors` | int\|null | 常无 | 隐藏 |
| `active_kcal` | number | `calories.calories`（**勿**用 steps.calories） | `rings.move` |
| `exercise_minutes` | int | `intensity.duration` | `rings.exercise` |
| `stand_hours` | int 0–24 | `valid_stand.count` | `rings.stand`（有效站立小时，非 Apple 同款） |
| `resting_hr_bpm` | int\|null | `heart_rate.avg_rhr` | heartRate.resting |
| `hr_zone_minutes` | object\|null | `*_hr_zone_duration` 五档 | zones（映射表另附） |
| `sleep_score` | int\|null | 可来自 sleep 日/raw | sleep.score |
| `started_at` | timestamptz | **幂等用**：该日 `00:00:00+08:00` | — |

### 3.2 `hr_sample` → `samples` (`record_type=heart_rate`)

| 字段 | 上游 |
|------|------|
| `started_at` | `value.time` / 行 `time` |
| `bpm` → `value_num` | `bpm` |
| `extras.type` | 可选 `type` |

### 3.3 `sleep_session` → `sleep_sessions` + `sleep_stages`

| 字段 | 上游 |
|------|------|
| `started_at` / `ended_at` | `bedtime` / `wake_up_time` |
| `score` | `sleep_score` |
| `stages[]` | 深/浅/醒/REM；`stage` ∈ `deep\|light\|rem\|awake`；无 REM 设备可缺 |

跨日：明细绝对时间；归属日按 **起床日** Asia/Shanghai。

### 3.4 `workout` → `workouts`

| 字段 | 上游 `sport_records` |
|------|----------------------|
| `started_at` | 外层 `time` == `value.start_time` |
| `ended_at` | `end_time` |
| `sport_type` | `sport_type` / 外层 `key` |
| `duration_sec` | `duration` |
| `distance_m` | `distance` |
| `active_kcal` | `calories` |
| `avg_hr_bpm` / `max_hr_bpm` | `avg_hrm` / `max_hrm` |
| `vendor_sid` | 外层 `sid` |

### 3.5 可选后续（V1 可不入库）

- 分时 `steps` / `valid_stand` 区间 → `samples`  
- SpO2 / stress → `samples`  
- GPS 明细 → 对象存储，不进本 batch

---

## 4) 幂等键（对齐 FORGE-005）

FORGE-005：`UNIQUE (device_id, record_type, started_at)` —— **可直接接**。

| record | `record_type` | `started_at` |
|--------|---------------|--------------|
| 日汇总 | `daily_summary` | 当日 00:00+08:00 |
| 心率点 | `heart_rate` | 采样时刻 |
| 睡眠 | `sleep_session` | bedtime |
| 运动 | `workout` | start_time |

冲突：`UPSERT`，较新 `observed_at` / `ingested_at` 覆盖。  
多 `sid`：优先一设备一行 `devices`；`vendor_sid` 进 `external_id` 或 `extras`。

---

## 5) Ingest 响应

```json
{
  "sync_run_id": "uuid",
  "accepted": 12,
  "upserted": 10,
  "unchanged": 2,
  "rejected": [{ "index": 3, "reason": "missing_started_at" }]
}
```

单条 reject，不整批回滚。

---

## 6) 请 BOT-066 锁稿时改的两点

1. `devices.source`：`'mi_health'` 替换 / 并存 `'huami_mifit'`（注释同步：禁止存 passToken）。  
2. `daily_aggregates`：确认有 `stand_hours`（或等价列）← `valid_stand.count`；**不再**当「无站立源」。

---

## 7) 待决（不阻塞 v0.2）

仓库名（155）；手环代数；`sid` 跨日稳定性；REM；区间分钟单位终裁；`passToken` 寿命；凭证录入走 Marco **1:1** vault。

---

*BOT-061 · FORGE-003 path F contract v0.2 · 栈 X · 2026-10-28 Asia/Shanghai*
