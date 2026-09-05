# Direction Approved

## 展示记录（2026-09-04）

| 方向 | 逻辑 | 文件 | 截图 |
|---|---|---|---|
| A · Maestro Mobile Star Atlas | 🎲 秒数轮盘 #9 → 复古未来太空图录 | design-demos/a-cosmic-retro.html | design-demos/shot-a.png |
| B · Linear × Miuix | 🏆 现实参照 → Linear 学派 | design-demos/b-linear-ref.html | design-demos/shot-b.png |
| C · HyperOS 本尊 | 🧠 最佳设计师 → 小米 HyperOS 设计团队 | design-demos/c-hyperos-native.html | design-demos/shot-c.png |

## 用户选择原话

> C

（在三版截图全部展示后，用户单选 C）

## 选定方向诠释

**方向 C ·「HyperOS 系统设计团队本尊」**：如果小米官方为 Pi Agent 出一个手机操控 App。
- light-first，白底规范页展示层，三画框并排可自由切 tab 走完 6 屏
- 控制中心式 Host 连接卡、SliderPreference / SwitchPreference 设置行、WindowDialog 决策弹窗
- Miuix 真实 token（spec §6）+ 官方徽标内嵌

## 后续约束

- 终稿基于 `c-hyperos-native.html` 深化，不再重开方向
- 保持三方向胜出的理由：最贴 Miuix/HyperOS 血统、light-first 最日常、规范页形态天然承载「组件规范复用」的表达

---

## Dashboard / Monitor 重设计选择（本次会话）

### 展示方向

| 方向 | 核心逻辑 | 文件 | 截图 |
|---|---|---|---|
| A · 态势总览 | Dashboard 优先，汇总资源、窗口、Run、Teammate 与 Attention | `design-demos/redesign-a-command-overview.html` | `design-demos/screenshots/redesign-a-command-overview.png` |
| B · Monitor 控制室 | Monitor 作为跨窗口监督会话和事件时间线 | `design-demos/redesign-b-monitor-control-room.html` | `design-demos/screenshots/redesign-b-monitor-control-room.png` |
| C · 会话流融合 | 首页采用实时动态流，窗口展开后直接对话 | `design-demos/redesign-c-activity-stream.html` | `design-demos/screenshots/redesign-c-activity-stream.png` |

### 用户选择原话

> A

### 选定方向诠释

**方向 A ·「态势总览」**：Dashboard 成为移动端第一入口，以等待处理事项和运行态势为主；Monitor 保持独立 Tab，但升级为可选择 `#window.*` 目标并发送监督消息的系统会话；Settings 移除 Maestro 通用键值编辑，改为连接安全、通知、同步和版本诊断。

### 后续约束

- 定稿基于 `redesign-a-command-overview.html` 深化，不重新开启三方向选择。
- Dashboard 第一优先级是 Ask / Attention，其次才是 Token、窗口和 Run 统计。
- 目标窗口通过可视化选择器选择，用户不必手写 `#window.*`。
- Token 用量、Pi / pi-maestro-flow / Maestro CLI 版本在 Host 未提供真实字段前必须标识为待接入数据，不伪装为现有能力。
