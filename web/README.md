# FORGE-002 · Marco健康管家（UI）

Apple Fitness 风格的手机端界面，由本仓库的 Node 进程提供，数据来自读 API，不再使用浏览器内的模拟对象。

## 如何预览

在仓库根目录：

```bash
cp .env.example .env
docker compose up -d
npm run migrate
npm start
```

浏览器打开 http://127.0.0.1:3000/

`GET /` 是这个页面。`app.js` 请求：

- `GET /v1/read/today`
- `GET /v1/read/trends?range=week|month`

圆环对应日汇总列，名称不改：

- 活动 ← `active_kcal`（目标 650 千卡，仅界面）
- 锻炼 ← `exercise_minutes`（目标 30 分钟）
- 站立 ← `stand_hours`（目标 12 小时）

所请求的日期在 `daily_aggregates` 中没有行时，接口回放 `fixtures/mi_health/ingest-batch-0.2.json`，JSON 里 `source` 为 `"fixture"`。有行时 `source` 为 `"db"`。时区为 Asia/Shanghai。

## 主题切换（深色 / 浅色）

- 默认深色；可切换浅色，视觉仍贴近 Apple Fitness（白卡片 + 彩色圆环）。
- 入口：今日 / 趋势页标题旁的圆形按钮，或「我的 → 外观」。
- 选择写入 `localStorage` 键 `marco-theme`（`dark` | `light`），刷新后保持。
- `<html data-theme="light|dark">` 驱动 CSS 变量；首屏有内联脚本避免闪烁。

## 文件结构

```
web/
├── index.html   # 页面结构（中文文案）
├── styles.css   # Apple Fitness 视觉（深/浅双主题）
├── app.js       # 读 API + 圆环动画 + 图表 + Tab + 主题
├── README.md    # 本说明
└── DESIGN.md    # 设计 tokens
```

## 各 Tab 内容

| Tab | 覆盖模块 |
|-----|----------|
| **今日** | ① 活动三环（活动/锻炼/站立）② 步数+距离 ③ 心率（静息/区间/最近）④ 睡眠（时长+阶段）⑤ 卡路里+锻炼历史 |
| **趋势** | ⑥ 周/月趋势：三环完成度、步数、静息心率、睡眠时长、活动消耗（本周 / 本月切换） |
| **我的** | 个人资料 stub、外观主题、设备说明、每日目标、关于 |

## 设计分辨率

外框约 **390×844**（iPhone 14 量级），居中于桌面背景。窄屏（≤420px）时取消外框，全屏展示。内容区底部留白避开固定 Tab bar（含 safe-area）。

总消耗没有入库列，界面显示为「—」。`floors` 为空时隐藏爬升。分时步数仅在 `samples.record_type = steps_minute` 有点时绘制。
