# FORGE-002 · Marco健康管家 · 设计说明（Design Tokens）

视觉语言对齐 **Apple Fitness / Fitness+**：粗圆环、高饱和强调色、大数字、干净卡片。默认深色；浅色模式为独立 token 集，非简单反色。

## 主题

- 根节点：`<html data-theme="dark|light">`
- 持久化：`localStorage["marco-theme"]`
- 切换入口：今日/趋势标题旁图标、「我的 → 外观」开关

## 颜色 · 深色（默认）

| Token | 值 | 用途 |
|-------|-----|------|
| `--bg` | `#000000` | 主背景 |
| `--bg-elevated` | `#1c1c1e` | 卡片底 |
| `--bg-card` | `#2c2c2e` | 次级面 |
| `--label` | `#ffffff` | 主文字 |
| `--label-secondary` | `rgba(235,235,245,0.6)` | 次要文字 |
| `--label-tertiary` | `rgba(235,235,245,0.3)` | 辅助 / 未选中 Tab |
| `--ring-track` | `#2c2c2e` | 圆环轨道 |
| `--move` | `#fa114f` | 活动环（红粉） |
| `--exercise` | `#92e82a` | 锻炼环（绿） |
| `--stand` | `#00d4ff` | 站立环（青蓝） |
| `--teal` | `#64d2ff` | 睡眠评分等强调 |
| `--pink` | `#ff375f` | 卡路里强调 |
| `--focus` | `#0a84ff` | 键盘焦点环 |

## 颜色 · 浅色

| Token | 值 | 用途 |
|-------|-----|------|
| `--bg` | `#f2f2f7` | 系统灰底 |
| `--bg-elevated` | `#ffffff` | 白卡片 |
| `--label` | `#1c1c1e` | 主文字 |
| `--label-secondary` | `rgba(60,60,67,0.68)` | 次要文字 |
| `--label-tertiary` | `rgba(60,60,67,0.4)` | 辅助 |
| `--ring-track` | `#e5e5ea` | 圆环轨道（浅灰） |
| `--move` / `--exercise` / `--stand` | 同系饱和色，略偏可读 | 圆环保持彩色 |
| `--focus` | `#007aff` | iOS 蓝焦点 |
| `--tab-bg` | `rgba(255,255,255,0.92)` | 毛玻璃底栏 |

浅色卡片带极轻阴影，避免「洗白反色」感；圆环彩色不变，轨道改为浅灰。

### 心率区间

静息 `#5e5ce6` · 热身 `#64d2ff` · 燃脂 `#30d158` · 有氧 `#ffd60a` · 无氧 `#ff9f0a` · 极限 `#ff453a`  
（浅色下略调至 iOS 系：`#5856d6` / `#007aff` / `#34c759` 等）

### 睡眠阶段

深睡 · 浅睡 · REM · 清醒（同上，深/浅各一套 token）

## 圆环语义

| 环 | 含义 | 模拟目标 | 当前样例 |
|----|------|----------|----------|
| 外环 · 活动 | 活动消耗（千卡） | 650 | 620 |
| 中环 · 锻炼 | 中高强度分钟 | 30 | 32（已超额） |
| 内环 · 站立 | 站立小时数 | 12 | 10 |

图例：`legend-value-line` 使用 `white-space: nowrap`，数值与 `/目标 单位` 同一行不换行。

SVG `pathLength="100"` + `stroke-dasharray` 驱动进度；加载时带缓动动画。超额目标视觉上封顶 100%。

## 字体

```
-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
"PingFang SC", "Helvetica Neue", "Segoe UI", sans-serif
```

| 层级 | 尺寸 | 字重 |
|------|------|------|
| Hero（页标题） | 34px | 700 |
| 大数字 | 28px | 700 |
| 卡片标题 | 17px | 600 |
| 正文 | 15px | 400–600 |
| Caption | 13px | 500–600 |
| Footnote | 11px | 400–500 |

数字使用 `font-variant-numeric: tabular-nums`，标题 `letter-spacing: -0.02em`。

## 间距与圆角

- 卡片圆角：`18px`
- 卡片内边距：`20px`
- 卡片间距：`16px`
- 小圆角（进度条等）：`10px` / `3–4px`
- 底部安全区：`34px`（Tab bar 下方）
- 内容区顶部：去掉模拟状态栏后用紧凑内边距，并尊重 `env(safe-area-inset-top)`，避免日期钻进刘海
- 内容区底部留白：`tab-h + safe-bottom + 28px`（并兼顾 `env(safe-area-inset-bottom)`），避免末张卡片被底栏遮挡
- 手机框：`390×844`，外圆角 `44px`

## 布局

1. **桌面**：渐变 backdrop + 居中手机外框（无模拟状态栏 / 刘海）
2. **内容区**：可滚动 `main`，底部留出 Tab bar 高度
3. **Tab bar**：毛玻璃半透明，三项「今日 / 趋势 / 我的」

## 无障碍

- 跳过链接「跳到主要内容」
- 语义标题 `h1–h3`、`role="tablist" / tab / tabpanel"`
- 圆环与图表带 `aria-label`
- 可见 `:focus-visible`（蓝色焦点环）
- 进度条 `role="progressbar"` + `aria-valuenow`
- 主题按钮带 `aria-label` / `aria-pressed`
- `prefers-reduced-motion` 时缩短动画

## 交互

- Tab 切换无刷新；趋势页「本周 / 本月」分段控件重绘 SVG 柱状/折线
- 圆环、区间条加载时动画填充
- 键盘：Tab 栏支持方向键 / Home / End
- 主题切换立即生效并写入 localStorage；切换时重绘图表轴标签色

## 文案语言

界面文案全部为**简体中文**。产品名：**Marco健康管家**。数据为样例，非真实设备同步。
