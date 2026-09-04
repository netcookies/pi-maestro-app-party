# Maestro Mobile × Miuix 交互设计稿 · 统一设计 Spec（三版共用输入）

> 本 spec 是三个设计 subagent 的唯一共同输入。三版同内容、异设计，仅供用户横向对比选择。

## 1. 产品是什么

**Maestro Mobile**（本仓库 `pi-maestro-app-party`）：在手机上远程操控 PC 端 Pi Agent + pi-maestro-flow 的移动端 App（Expo / React Native）。用户在手机上完成：

- 连接 PC 端 Host（WebSocket 地址 + Token）
- 浏览 / 新建 Agent 会话，读 Agent 输出、发消息
- 回应 Agent 的 `ask-user-question` 弹窗（选项卡 / 多选 / 自由输入）
- Teammate 调度监控（dispatch / step / schedule 状态）
- Monitor 窗口观察（窗口状态、attention 告警、todo 列表）
- 设置（Host 参数、主题、数值调参项）

## 2. 目标受众与场景

移动开发者 / Agent 重度用户。单手躺在床上或沙发上，碎片时间查看和推进 PC 上跑着的 Agent 任务。核心诉求：**一眼看清状态、快速决策、随时插话**。

## 3. 核心信息与内容板块（设计稿必须覆盖的界面）

设计稿以「单屏手机 mockup 平铺 + 关键屏可交互」呈现，至少包含：

1. **连接页 Home**：Host 地址输入、Token 输入、连接状态（已连接 / 重连中 / 未连接三态）、历史连接
2. **会话列表**：Host 会话卡片（标题、最近消息预览、时间、活跃状态点）
3. **会话聊天页**：Agent 消息流（含工具调用折叠条）、底部输入框、ask 弹窗（extension_ui bridge：2-4 选项单选卡片）
4. **Teammate 调度页**：dispatch 列表（dispatchId、state 徽标、task 摘要）、step 子列表
5. **Monitor 页**：窗口卡片（名称、status、objective）、Attention 告警条（severity 色点）、Todo 进度
6. **设置页**：数值调参项（每页消息数、轮询间隔等）、主题选择、连接状态卡

底部导航（NavigationBar）：Home / 会话 / Teammate / Monitor / 设置。

## 4. 情感基调与气质关键词

- **关键词**：工程感、可靠、冷静、锐利、暗夜工作台
- 不是消费级 App 的圆润可爱，是给开发者用的专业工具
- Agent 正在干活的感觉要有「活动感」：进度、状态点、时间戳、日志感排版

## 5. 输出格式与尺寸（三版必须统一）

- **形态**：单文件 HTML，`file://` 双击可开
- **画布**：页面居中一块 390×844 手机画框（iPhone 14 尺寸），所有屏幕在画框内
- **Miuix 图标资产**：`assets/miuix-icon-datauri.txt` 中的 data URI（webp），必须内嵌到展示 Miuix 组件规范标识处（页眉「Miuix 设计体系」徽标处），不得用外链
- **交付路径**：`miuix-prototype/design-demos/<逻辑名>.html`

## 6. Miuix 设计规范（真实 token，必须遵守）

来源：https://compose-miuix-ui.github.io/miuix/components + 源码 Colors.kt / TextStyles.kt

### 色板（light / dark 两套，从源码提取的真实值）

| Token | Light | Dark |
|---|---|---|
| primary | #3482FF | #277AF7 |
| onPrimary | #FFFFFF | #FFFFFF |
| primaryVariant | #3482FF | #0073DD |
| onPrimaryVariant | #AECDFF | #99C7F1 |
| error | #E94634 | #F12522 |
| errorContainer | #FDF6F4 | #2E0603 |
| onErrorContainer | #410002 | #FFDAD6 |
| primaryContainer | #5D9BFF | #338FE4 |
| tertiaryContainer | #EAF2FF | #2B3B54 |
| onTertiaryContainer | #3482FF | #4788FF |
| background | #FFFFFF | #242424 |
| onBackground | #000000 | #E6FFFFFF (rgba(255,255,255,.9)) |
| onBackgroundVariant | #8C93B0 | #787E96 |
| surface | #F7F7F7 | #000000 |
| onSurface | #000000 | #F2F2F2 |
| surfaceVariant | #FFFFFF | #242424 |
| onSurfaceSecondary | rgba(0,0,0,.8) | rgba(255,255,255,.8) |
| onSurfaceVariantSummary | rgba(0,0,0,.6) | rgba(255,255,255,.5) |
| disabledOnSurface | #B2B2B2 | #666666 |
| secondaryContainer | #F0F0F0 | #434343 |
| onSecondaryContainer | #A9A9A9 | #7C7C7C |
| surfaceContainerHigh | #E8E8E8 | #242424 |
| surfaceContainerHighest | #E8E8E8 | #2D2D2D |
| outline | #D9D9D9 | #404040 |
| dividerLine | #E0E0E0 | #393939 |
| windowDimming | rgba(0,0,0,.3) | rgba(0,0,0,.6) |
| sliderKeyPointForeground | #6EB5FF | #5DAAFF |

### 字号（sp → px 1:1）

| Style | px | 备注 |
|---|---|---|
| Title1 | 32 | 大标题 |
| Title2 | 24 | |
| Title3 | 20 | |
| Title4 | 18 | |
| Main / Button | 17 | 正文主字号、按钮文字 |
| Body1 | 16 | |
| Body2 | 14 | 次级文字 |
| Subtitle | 14 Bold | 卡片小标题 |
| Footnote1 | 13 | |
| Footnote2 | 11 | 辅助说明 |

### 形状与交互规范

- 卡片大圆角（HyperOS 风格，约 16-18px），列表条目小圆角
- Switch：Miuix 式药丸开关，primary 色
- Slider：连续滑轨 + primary 填充 + keyPoint 圆点（sliderKeyPointForeground）
- TextField：浮动 label（聚焦 / 有内容时 label 上浮变小）、圆角填充底（secondaryContainer）
- Button：primary（蓝底白字）/ secondary（灰底）/ text 三级
- TopAppBar：大标题式（Title2/3），可含返回箭头与动作按钮
- Snackbar：底部浮出短反馈条
- 明暗两套主题都必须真实可用（设计稿提供 light/dark 切换）

## 7. 图片需求

- 仅 Miuix 官方图标一枚（已提供 data URI），用作设计体系徽标
- 不需要照片类内容。装饰图形用 CSS 几何实现，不留空占位

## 8. 视觉母题假设

「**状态即内容**」：Maestro Mobile 的每个界面都在回答一个问题——"我的 Agent 现在怎么样了？" 状态点、时间戳、进度、日志等元素不是装饰，是主角。视觉母题：**细线轨道 + 亮色状态点**（呼应 Miuix Slider 的 keyPoint 语言），贯穿连接状态、会话活跃度、teammate 调度、monitor attention。

## 9. 已知约束

- 不得使用 iOS / Material 原生样式直接套壳——这是 Miuix（HyperOS）组件语言的还原
- 反 AI slop：不用紫渐变、不用 emoji 图标、不编造 data slop
- 屏内文字用真实项目文案（中文为主，技术名词保留英文），不得 Lorem ipsum
- 正文 ≥14px、注释 ≥12px、对比度 ≥4.5:1
- 交互演示至少覆盖：明暗主题切换、Tab 切换、ask 弹窗弹出/作答、Switch/Slider 可操作、Snackbar 反馈
