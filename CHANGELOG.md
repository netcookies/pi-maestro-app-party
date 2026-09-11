# Changelog

本文件记录 Maestro Mobile 的显著变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.3.0] — 2026-09-11

### 修复

- 修复会话卡片底部细条为真实上下文窗口占用百分比并打通活跃会话真实用量
- 补充重连状态与配对引导的双语国际化支持
- 修复上下文窗口与token数据伪造问题并支持卡片实时双语切换
- 修复设置页闪退、标题粗体暖黄继承、普通行内代码去灰底与助手气泡对齐
- 修复列表文本丢失、行内代码加粗嵌套失效、标题层级显示及扫码后相机未释放
- 彻底消除消息重复渲染两次问题
- 增加双向应用层 ping 保活与图文混排 Markdown 渲染
- 支持 custom_message(teammate 信箱消息)增量广播与历史回放，并在注入 TUI 时乐观回显用户消息
- 收到任何 message 均清零心跳漏答计数，防止活动客户端被误杀 (HEARTBEAT_MAX_MISSES=3)
- 修复手机打开会话时递归加载扩展引发空指针崩 host 进程的致命缺陷
- cancelAll 先快照清空再通知，单条 emit 失败不阻断其余（S_CONFIRM RV-003）
- ask 失效必须双向通知——host 超时/abort 也发 cleared，mobile 真出队（S_CONFIRM RV-001/002）
- 复评修正——恢复弹窗保留原时限；完成 store 的类型清理（S_CONFIRM）
- 评审收口——dist 陈旧产物、断连弹窗丢失、裸 IPv6 白名单、本地错误域分离
- WS Origin 校验纳入 scheme 与端口，修复 IPv6 与裸 hostname 配置（ISS-20260910-005）
- ExtensionUiQueue 回收终态弹窗条目，驻留有界（ISS-20260910-004）
- validateClientCommand 收紧 id 类型校验并对齐服务端拒因（ISS-20260910-003）
- mobile 重连退避加 jitter（ISS-20260910-006）
- mobile 意外断连立即以可区分错误 settle 在途命令（ISS-20260910-002）
- live 条目走同一驻留上限，剪除时回收以 id 为键的旁路状态
- 评审收口——心跳漏答容忍、close 后短路、索引写失败降级；补 telemetry 覆盖
- live-sessions 行数统计的残行上限（同族无界累积）
- maestro-state 先 stat 校验大小再读（顺序缺陷）
- jsonl-pager 异常超限行计数与告警 + 回归双向验证
- error 帧补 seq + jsonl-pager 残行上限（泛化发现，未提交前的部分实现）
- 错误响应必须回显 in_reply_to（客户端命令不再挂 30s 超时）
- 按独立评审修正硬顶语义与脱敏误伤
- 恢复被 build.sh 抹掉的 WS 隔离实现
- WS 边界故障隔离与出站背压收口
- 修复守护进程静默退出与大会话扫描 OOM
- 防止图片 base64 进入实时事件
- 修复分页历史中的图片回显
- 增加系统级二维码扫描回退
- 配对二维码 PNG 单一固定名 + 0600 权限 + 清理历史遗留
- QR payload 全兼容形态（ws+token+ips 内联 + c= 短码）— PNG 解除尺寸约束
- 扫码识别但不解析时显示原文（不再静默忽略）+ 配对码手动输入入口
- QR 带全部候选 IP + App 并行换码 — 修复首选 IP 不可达死锁；v0.2.8
- 版本号单一来源 app.json — Android gradle 读取（versionCode=semver 推导）+ iOS Info.plist prebuild 同步；bump 0.2.6
- QR 回退短 payload（29 行码终端渲染变形无法扫描，实测复现）— 候选 IP 改走 /api/pair-ips 拉取
- 修复真机无法连接的三层根因 + 深链配对页 + 冷启动自动连接（0.2.2）
- lanIp 排除虚拟接口（utun/bridge/docker 等）并按物理网段排序，QR 编码手机可达的 IP
- token 错误判定改用 HTTP /api/health 探测确认（refused 不再误报）
- 重建 extension.ts（widget/qr/竞争锁曾随 vendor checkout 丢失，0.1.3-0.1.5 皆未含）+ host-client token 错误停止重连并报明确提示
- stage publish 后续 grep 行缩进回归 YAML run 块
- 秠除 stage list（trust token 无权执行子命令）+ 揌取 stage-id 屏显
- npm@11（node22 兼容 + OIDC trusted publishing 支持）
- Trusted Publishing 需要 npm>=11.5.1 — publish 前 npm install -g npm@latest
- pnpm-lock 补 qrcode-terminal（qrcode 依赖引入时漏刷新）
- 默认 0.0.0.0 + 持久化 token + vendor import 残留清零
- prepublishOnly 先构建 shared dist（CI 上 vitest 解析 @maestro-mobile/shared 失败）
- Decode keystore 工作目录改为 apps/mobile/android（local.properties 相对路径）
- pnpm 版本单一来源 — 交给 package.json packageManager 字段
- pnpm setup 先于 setup-node（cache: pnpm 依赖 pnpm 在 PATH）
- cli.ts 残留旧名清零 — 上次改名被 vendor 脚本 checkout 还原（发布包 v0.1.0 带 12 处旧 banner）
- 图片路径提取支持 Windows — 盘符路径/file:///C:/ URI + isImagePath 扩展
- version-detector Windows 兼容 — .cmd shim 探测 + %APPDATA% 全局目录
- 移除竖屏强制锁定 — App 跟随设备自然方向
- 全项目 code review P0-P3 修复
- 对齐 Expo SDK 53 官方锁定版本 — 修复 Android 崩溃与 iOS 编译
- collectChanges 在 tag 不存在时回退全量 HEAD — 修复首次发版崩溃
- 移除残留的重复 JSX 标签
- statusColor 补 theme 参数 — 修复 owner 卡渲染崩溃
- 空状态判断包含 owners — owners 有数据时不再被空状态遮挡
- 进入页面主动拉取 monitor state — 修复看不到当前 teammate
- 移除重复的 Row 类型声明
- 会话页去除双重 header 与底部空白
- 自动重连兜底默认地址 — hostUrl state 兜底而非依赖 AsyncStorage 有值
- 未连接时不再抛 HostClient not initialized 错误页
- pod install 安装 RNSVG 原生依赖 — 修复 react-native-svg 模块缺失报错
- 全屏工具面板改内嵌 overlay — 修复弹窗层级/关闭/无响应
- 全屏工具栏改内嵌面板(非独立 Modal, 彻底解决层级)
- 全屏模式弹窗层级 + Think/Plan 弹窗加关闭按钮
- skills 数据格式适配 — resourceLoader 返回对象数组
- 修复模型列表/skills加载/图片权限三个问题
- 修复 reviewer 发现的 12 项问题
- 消息重叠修复 — ListHeader 改列表首项 + Markdown 外层隔离
- ErrorBoundary 降级保护 + 长内容换行
- 修复顶部懒加载后弹回底部死循环
- ws:// → http:// 图片 URL（RN Image 不支持 ws 协议）
- 修复模拟器运行 3 个问题 — 黑屏/模块解析/Provider 缺失

### 样式

- 统一会话页与监控页输入框右侧发送按钮为高光色小飞机图标

### 新增

- 接入 @ronradtke/react-native-markdown-display 9.x 重构 AI Chat 消息渲染层
- 落地方案B Bento Grid UX 重构与双语国际化支持
- 精简模型选择页——消除重复取消键，将确认应用按钮优雅整合至顶栏右上角
- 方案 B 语义化精修——右上角点击切换模型、重新设计思考/计划/压缩三大语义图标
- 方案 B 细节精修——连接状态去重、单色浮动单图标药丸工具条、绿色微光圆点
- 深度落地 7 项精确指令——监控dock上方弹出输入、多条Ask队列轮播、Floating快捷条、FAB一键到底、标准四件套输入栏
- 方案 B 进一步微调——底部原位全宽搜索、外观三段式、设置页顺序重构与版本置底
- 方案 B 原型补齐 5 项遗漏——黑夜白天换肤、搜索独立FAB、版本诊断卡片、术语全量双语
- 交付包含全部生产业务功能的方案 B 完整设计原型
- 交付方案 B (便当盒工坊) 深化全功能高保真交互原型
- 升级交互原型——清除彩色emoji改用单色SVG，重构三种鲜明架构差异
- 交付 UX 重构与三方向交互原型 HTML (huashu-design)
- 完成移动端图片回显与配对流程优化
- 重构配对流程并分页加载会话
- 配对码 QR 改为高对比度 PNG 输出并自动打开
- 两段式短码配对 — QR 只带 8 位码+首选 IP（~60 字符/15 行稳扫），App 换码后弹 IP 选择层
- 扫码配对 + 多 Host 实例 + token 错误明确提示（0.2.0）
- npm 发布切回 Trusted Publisher 直发（包 publishing access 已改 allow trusted-publisher tokens）；v0.1.5
- npm 发布改走 staged publishing — CI 免 2FA 暂存，维护者 approve 触发发布（npm 官方推荐流）
- TUI 状态栏 widget + /maestro-mobile qr 二维码 + start 竞争锁 + token 持久化
- Trusted Publishers（OIDC）发布 — CI 无需 NPM_TOKEN；包名定稿 pi-maestro-mobile
- release 签名(Isulew.jks via local.properties/env) + minify/shrinkResources 默认启用 + proguard 规则
- pi 扩展薄遥控器 — /maestro-host status|start|stop
- 方向 A 落地 — Dashboard 工作台 + Monitor 监督会话 + 三数据源接入
- owner 卡渲染 teammate agent 详情
- 接通 teammate/monitor 合同 — workspace-telemetry 读取 owner 运行时
- 启动自动重连 — 读持久化连接参数自动 connect
- 视觉对齐设计稿 — Teammate 状态徽标+竖轨rail / Monitor 告警条+todo轨道+进度条 / 设置 SegmentedControl+Slider行+关于卡 / 聊天 chevron 返回钮
- Tabs 底部导航架构（对齐设计稿 NavigationBar）— Host 连接卡迁移至会话页顶部控制中心卡
- ChatComposer emoji 图标换线性 SVG（react-native-svg LineIcon 组件，与设计稿同语言）
- Miuix 设计规范交互设计稿 — HyperOS 方向终稿与三方向初稿存档
- 布局定稿 [/][📎][输入框][✈️] + 全屏编辑模式
- 聊天框增强 — 模型切换/发图片/skill联想/Plan模式/compact/重命名 + Maestro设置集成
- 5项优化 — 懒加载锚点/布局/Tab搜索/会话内搜索/参数配置
- 自研轻量 Markdown 渲染器(替代 markdown-display)
- 一键到底部 FAB + 修复双击回顶连环加载
- 长会话懒加载 — 只加载尾部 80 条, 滚动到顶分页加载更早
- toolCall 折叠/展开/全屏 + 多主题切换(持久化) + Markdown 渲染
- user/assistant 消息图片渲染 + read toolCall 图片提取 + 当前项目会话可打开
- 会话历史完整回放 + 图片缩略图/全屏预览
- 会话历史完整回放 tool 输出（bash 表格/日志/路径）
- 活跃会话感知 + 修复假 ask 弹窗
- Host 会话列表 + 打开已有会话 + 历史回放
- iOS 模拟器编译成功 (MaestroMobile.app) + fmt 兼容修复
- Android APK 编译成功 (145MB) + iOS 原生项目 + 全部 UI 页面
- 移动端 UI 页面 + Expo 原生项目 — Chat/Connect/Teammate/Monitor/Settings
- 常驻启动 + 分发准备 — CLI 入口 + launchd/systemd/Docker + README
- 端到端联调测试 — ask 闭环 + maestro 状态流 + 重连
- 移动端核心逻辑层 — HostClient + ExtensionUiQueue + AppState reducer
- host 端 Maestro Bridge — 状态变更检测 + /api/maestro 路由
- maestro-mobile monorepo 骨架 — shared 协议 + host 直连服务器

### 其他

- update MaestroMobile-unsigned-0.2.15.ipa with deduplication fix
- release MaestroMobile-unsigned-0.2.15.ipa
- bump CFBundleShortVersionString to 0.2.15 (15)
- bump mobile version to 0.2.15
- update 0.2.14 ipa with latest refactor
- update release ipa name to 0.2.14
- bump version to 0.2.14
- 删除 host 死代码（ISS-20260910-001）
- 新增 ws-payload-relay P0-4 入站 payload 实测工具
- bump 版本至 0.2.13
- bump 版本至 0.2.12
- bump 版本至 0.2.11
- v0.2.10 — QR 全兼容 payload（旧 App 也能弹 IP 选择层）
- v0.2.9 — 配对码 PNG 高对比度输出 + 手动输入配对码 + 解析失败可见化
- v0.2.7 — 两段式短码配对
- v0.2.5 — QR 短码 + /api/pair-ips 候选拉取
- v0.2.4 — /maestro-mobile 默认 start/status + 扫码多候选 IP 选择弹层
- v0.2.3 — 连接体验批次（幽灵修复/多IP扫码/跳转/活跃tab/性能/状态栏）
- v0.2.2
- v0.2.1 — token 误判修复 + lanIp 虚拟接口排除
- v0.2.0 — 扫码配对/多 Host/token 错误提示
- v0.1.4 — 补齐 widget/qr/竞争锁（0.1.3 tag 时序问题漏带）
- v0.1.3 — widget/二维码/竞争锁/默认 0.0.0.0
- tag 触发 release workflow + 本地发布脚本 release-local.sh
- v0.1.1 — cli banner 旧名清零后的补丁发布
- 发布化改造 — @maestro-mobile/host → 独立 npm 包 pi-maestro-host
- 仓库地址修正为 netcookies/pi-maestro-app-party
- 清理全页面残留 emoji（detail 行/思考标签/搜索钮/工具卡/图片失败提示）

### 重构

- 简化 Origin 解析、重构 Jitter 纯函数与队列修剪
- 包名/bin 统一为 maestro-mobile（用户决策）
- 布局改 [输入框][/][📎] + 修复 no model 显示
- UI 重设计 — 附件图标+/按钮+图标文字工具栏

### 文档

- 三种部署形态 — npm 全局 / pi 扩展(规划) / Docker 看板模式
- README 配真实截图 + v1.0.0 发布说明(21 项 review 修复汇总)
- 通俗化 GitHub README + docs/ 架构协议文档 + release 脚本与 skill
- 发布前必要文档 — CHANGELOG / LICENSE / README 更新 / 包元数据

## [0.2.14] — 2026-09-11

### 修复与加固

- **WS 入站隔离**：单连接超限（>8MB）拦截抛出的 `RangeError`，防止宿主进程因未捕获异常退出（exit 99），仅断开问题连接。
- **出站背压收敛**：收敛裸 `ws.send` 为单一发送出口，引入软高水位（1MB）、硬上限（32MB）与 5s 宽限期，限制队列驻留内存。
- **心跳机制**：容忍单次 pong 漏答（连续 2 次无响应才断连），避免高负载下健康连接被误踢。
- **参数对齐**：修复 `sendError` 16 处 `in_reply_to` 误传问题，解决命令出错时客户端等待 30s 的现象。
- **死代码清理**：移除无生产调用的 `ws-command-handlers.ts` 与 `jsonl-replay.ts`，并在 `build.sh` 中添加 `rm -rf dist` 防止产物残留。
- **移动端与协议加固**：
  - 断连时立即以 `connection_lost` 标记未决命令，保留草稿。
  - 重连退避加入向下 Jitter，避免并发重连尖峰。
  - `validateClientCommand` 校验 `id` 类型。
  - 弹窗终态条目按容量单趟修剪，防止长期运行占用内存。
  - 优化 Origin 校验解析，支持多形态配置。

## [0.1.0] — 2026-09-05

首个可用版本：在移动端完整使用 Pi Agent + pi-maestro-flow。

### 新增

- **SDK Host 架构**（`apps/host`）：`PiSdkRuntimeFactory` → `createAgentSession`，`SdkSessionRunner` 订阅事件投影时间线；`MobileExtensionUiBridge` 把 maestro ask 的 RPC 调用转为 `extension_ui_request` 事件
- **移动端 App**（`apps/mobile`，Expo / React Native）：HostClient（WS 连接 + 自动重连 + 兜底默认地址）、ExtensionUiQueue ask 弹窗、AppState 事件流 reducer
- **ask 闭环**：maestro `ask-user-question` 在远程环境完整可用（select / input / confirm / 多问题 / multiSelect）
- **会话管理**：168+ 历史会话列表（搜索 / 全部 / 活跃 / 历史）、会话内 model / thinking 切换、compact、重命名
- **Teammate Tab**：workspace owners（活的 Pi 会话）+ 每个 owner 下正在运行的 teammate agents（name / status / phase / outputTail 实时日志）+ flow-schedule 调度列表
- **Monitor Tab**：窗口状态总览（running / sleeping / disconnected + work active/idle）
- **Workspace Telemetry**：读取 `~/.pi/teammate/workspaces/*/runtime/owners/*.json`（pi-maestro-teammate 持久化合同），心跳新鲜度判活，5s 轮询变化驱动推送
- **协议命令**：`get_maestro_state` / `get_monitor_state` 主动拉取（修复后连接错过推送的问题）
- **Maestro 设置编辑**：读取 + 修改 host 侧 maestro 配置文件
- **部署**：launchd plist（macOS）、systemd unit（Linux）、Dockerfile

### 修复

- 未连接时 Tab 页不再抛 `HostClient not initialized` 错误页
- 自动重连兜底默认地址（不依赖 AsyncStorage 残留值）
- 会话页双重 header 与底部空白
- Teammate Tab 空状态判断包含 owners、`statusColor` 缺 theme 崩溃、重复 JSX 标签

### 已知限制

- Teammate/Monitor 数据来自 pi-maestro-teammate 的 owner 文件心跳（90s 无心跳判为不活跃）
- iOS 真机安装需 Apple Developer 签名；模拟器构建免签
- 默认无鉴权监听 `0.0.0.0`，公网暴露必须配置 `MAESTRO_MOBILE_TOKEN`

[0.1.0]: https://github.com/netcookies/pi-maestro-app-party/releases/tag/v0.1.0
