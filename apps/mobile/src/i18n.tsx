import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type Language = "zh" | "en";
export type LanguageChoice = "auto" | "zh" | "en";

export interface I18nDictionary {
  tabWorkbench: string;
  tabSessions: string;
  tabMonitor: string;
  tabSettings: string;
  filterActive: string;
  filterAll: string;
  searchPlaceholder: string;
  statusStreaming: string;
  statusActive: string;
  statusIdle: string;
  contextLabel: string;
  tokensLabel: string;
  cacheLabel: string;
  messagesAndTime: string;
  msgCount: string;
  accentPalette: string;
  output: string;
  cost: string;
  pairedCode: string;
  retestLink: string;
  running: string;
  readyLabel: string;
  timeUnknown: string;
  justNow: string;
  minutesAgo: string;
  hoursAgo: string;
  daysAgo: string;
  activeStatusLabel: string;
  reasoningLabel: string;
  visionLabel: string;
  thinkLevelTitle: string;
  planModeTitle: string;
  compactTitle: string;
  compactDesc: string;
  compactConfirm: string;
  paramHistoryPageSize: string;
  paramThreshold: string;
  paramInterval: string;
  paramPreview: string;
  unitItems: string;
  unitChars: string;
  versionPiSummary: string;
  versionFlowSummary: string;
  versionCompatSummary: string;
  showAfterConnect: string;
  runningTime: string;
  sessionsCount: string;
  hubBackpressureVal: string;
  onlineBadge: string;
  offlineBadge: string;
  hostConnected: string;
  hubTitle: string;
  hubDesc: string;
  hubNode: string;
  hubHeartbeat: string;
  hubHeartbeatVal: string;
  hubBackpressure: string;
  btnRefresh: string;
  btnScan: string;
  btnCode: string;
  backBtn: string;
  swipeBackHint: string;
  nowRunningTitle: string;
  heroTitle: string;
  metric1: string;
  metric2: string;
  metric3: string;
  metric4: string;
  askTitle: string;
  askDesc: string;
  askConfirm: string;
  askReject: string;
  attentionTitle: string;
  steerPlaceholder: string;
  steerBtn: string;
  secAppearance: string;
  appearanceAuto: string;
  appearanceLight: string;
  appearanceDark: string;
  secLanguage: string;
  secHub: string;
  secParams: string;
  secVersion: string;
  versionApp: string;
  versionHost: string;
  versionPi: string;
  versionFlow: string;
  versionCli: string;
  versionCompat: string;
  versionCompatVal: string;
  allWindows: string;
  noWindows: string;
  waitingHostPush: string;
  noAlerts: string;
  alertCount: string;
  confirm: string;
  cancel: string;
  apply: string;
  selectModel: string;
  linesOutput: string;
  fullscreen: string;
  close: string;
  enterPairCode: string;
  pairCodeHint: string;
  scanQrTitle: string;
  alignQrHint: string;
  cameraPermRequired: string;
  cameraPermHint: string;
  grantCamera: string;
  goToSettings: string;
  selectIpTitle: string;
  selectIpHint: string;
  btnNext: string;
  btnRescan: string;
  connectingHost: string;
  savingHost: string;
  saveParams: string;
  notifAttentionLabel: string;
  notifAttentionDesc: string;
  wifiOnlyLabel: string;
  wifiOnlyDesc: string;
  confirmConnect: string;
  sendTo: string;
  sendSupervisionMsg: string;
  unnamedWindow: string;
  unknownPath: string;
  noWindowsDesc: string;
  modelWindow: string;
}

export const DICTIONARIES: Record<Language, I18nDictionary> = {
  zh: {
    tabWorkbench: "工作台",
    tabSessions: "会话",
    tabMonitor: "监控",
    tabSettings: "设置",
    filterActive: "活跃中",
    filterAll: "全部会话",
    searchPlaceholder: "输入关键词搜索标题、ID、路径...",
    statusStreaming: "流式生成中",
    statusActive: "活跃在线",
    statusIdle: "空闲等待",
    contextLabel: "上下文视窗",
    tokensLabel: "Token 消耗",
    cacheLabel: "缓存命中",
    messagesAndTime: "对话与时间",
    msgCount: "条对话",
    accentPalette: "高光主题色",
    output: "输出",
    cost: "成本",
    pairedCode: "配对码",
    retestLink: "重测链路",
    running: "运行中",
    readyLabel: "就绪",
    timeUnknown: "时间未知",
    justNow: "刚刚",
    minutesAgo: "分钟前",
    hoursAgo: "小时前",
    daysAgo: "天前",
    activeStatusLabel: "活跃状态",
    reasoningLabel: "深度思考",
    visionLabel: "视觉感知",
    thinkLevelTitle: "思考深度等级",
    planModeTitle: "计划模式",
    compactTitle: "压缩上下文确认",
    compactDesc: "此操作将对当前会话的历史上下文生成阶段性总结，并修剪超出视窗的对话记录，以降低 Token 消耗并提升响应速度。是否立即执行？",
    compactConfirm: "确认压缩",
    paramHistoryPageSize: "每页消息数",
    paramThreshold: "自动加载阈值",
    paramInterval: "活跃轮询间隔",
    paramPreview: "消息预览长度",
    unitItems: "条",
    unitChars: "字符",
    versionPiSummary: "桌面会话智能体引擎",
    versionFlowSummary: "工作流闭环策略",
    versionCompatSummary: "协议兼容状态",
    showAfterConnect: "连接后显示",
    runningTime: "运行",
    sessionsCount: "会话",
    hubBackpressureVal: "32MB 有界隔离 (1013)",
    onlineBadge: "在线",
    offlineBadge: "离线",
    hostConnected: "已连接主机",
    hubTitle: "通信与配对中枢",
    hubDesc: "经由 WebSocket (ws://) 安全隧道与桌面主机进程双向同步",
    hubNode: "主机节点",
    hubHeartbeat: "应用层心跳",
    hubHeartbeatVal: "20秒保活运行中",
    hubBackpressure: "出站背压",
    btnRefresh: "测速重测",
    btnScan: "扫码配对",
    btnCode: "输入配对码",
    backBtn: "返回",
    swipeBackHint: "← 屏幕左侧边缘右滑返回",
    nowRunningTitle: "现在运行中的会话",
    heroTitle: "当前活跃会话 Token 总用量",
    metric1: "活跃窗口",
    metric2: "今日 Run 完成",
    metric3: "协作者工作中 (Teammates)",
    metric4: "待决交互确认 (Ask)",
    askTitle: "待决交互确认 (Ask)",
    askDesc: "来自桌面插件界面的交互确认请求：",
    askConfirm: "批准执行",
    askReject: "拒绝",
    attentionTitle: "系统关注警告 (Attention)",
    steerPlaceholder: "输入协同干预指令 (Steer)...",
    steerBtn: "协同介入",
    secAppearance: "外观模式",
    appearanceAuto: "跟随系统",
    appearanceLight: "浅色白昼",
    appearanceDark: "深色黑夜",
    secLanguage: "系统语言 / Language",
    secHub: "服务器管理",
    secParams: "性能参数",
    secVersion: "版本信息",
    versionApp: "Maestro Mobile 客户端",
    versionHost: "桌面主机服务 (Host)",
    versionPi: "Pi 智能体会话引擎",
    versionFlow: "pi-maestro-flow 编排扩展",
    versionCli: "Maestro CLI 核心工具",
    versionCompat: "协议版本兼容性",
    versionCompatVal: "已兼容 (v3.0.0)",
    allWindows: "全部窗口",
    noWindows: "暂无窗口数据",
    waitingHostPush: "等待 Host 推送",
    noAlerts: "暂无告警",
    alertCount: "条告警",
    confirm: "确认",
    cancel: "取消",
    apply: "应用",
    selectModel: "选择会话模型",
    linesOutput: "行输出",
    fullscreen: "全屏",
    close: "关闭",
    enterPairCode: "输入 8 位配对码",
    pairCodeHint: "在 Mac 终端运行 /maestro-mobile qr 后的 8 位字符",
    scanQrTitle: "扫描配对二维码",
    alignQrHint: "对准 PC 终端上的二维码",
    cameraPermRequired: "需要相机权限来扫描配对码",
    cameraPermHint: "二维码在 PC 终端执行 /maestro-mobile qr 后显示",
    grantCamera: "授权相机",
    goToSettings: "去系统设置开启",
    selectIpTitle: "选择要连接的地址",
    selectIpHint: "请选择一个地址，然后点下一步。",
    btnNext: "下一步",
    btnRescan: "重新扫描",
    connectingHost: "正在连接主机…",
    savingHost: "正在保存配对…",
    saveParams: "保存参数",
    notifAttentionLabel: "高优先级关注通知",
    notifAttentionDesc: "收到 Ask 审核提问时轻震动",
    wifiOnlyLabel: "仅 Wi-Fi 下拉取超长历史",
    wifiOnlyDesc: "节约移动蜂窝数据流量",
    confirmConnect: "确认连接",
    sendTo: "发送到",
    sendSupervisionMsg: "发送监督消息",
    unnamedWindow: "未命名窗口",
    unknownPath: "未知路径",
    noWindowsDesc: "等待 Host 推送 monitor 状态",
    modelWindow: "视窗上限",
  },
  en: {
    tabWorkbench: "Workbench",
    tabSessions: "Sessions",
    tabMonitor: "Monitor",
    tabSettings: "Settings",
    filterActive: "Active",
    filterAll: "All",
    searchPlaceholder: "Search project, ID, model, path...",
    statusStreaming: "Streaming",
    statusActive: "Active Ready",
    statusIdle: "Idle",
    contextLabel: "Context Window",
    tokensLabel: "Token Usage",
    cacheLabel: "Cache Hit",
    messagesAndTime: "Messages & Time",
    msgCount: "messages",
    accentPalette: "Accent Palette",
    output: "Output",
    cost: "Cost",
    pairedCode: "Code",
    retestLink: "Retest",
    running: "Running",
    readyLabel: "Ready",
    timeUnknown: "Unknown",
    justNow: "Just now",
    minutesAgo: "m ago",
    hoursAgo: "h ago",
    daysAgo: "d ago",
    activeStatusLabel: "Status",
    reasoningLabel: "Reasoning",
    visionLabel: "Vision",
    thinkLevelTitle: "Thinking Depth",
    planModeTitle: "Plan Mode",
    compactTitle: "Compact Session",
    compactDesc: "This will create a stage summary of session history and prune truncated context to reduce token usage. Proceed?",
    compactConfirm: "Confirm Compact",
    paramHistoryPageSize: "Page Size",
    paramThreshold: "Preload Threshold",
    paramInterval: "Poll Interval",
    paramPreview: "Preview Length",
    unitItems: "items",
    unitChars: "chars",
    versionPiSummary: "Desktop Agent Engine",
    versionFlowSummary: "Workflow Loop Policy",
    versionCompatSummary: "Protocol Status",
    showAfterConnect: "Connected to show",
    runningTime: "Uptime",
    sessionsCount: "sessions",
    hubBackpressureVal: "32MB Bounded (1013)",
    onlineBadge: "ONLINE",
    offlineBadge: "OFFLINE",
    hostConnected: "Connected",
    hubTitle: "Host Connection & Pairing Hub",
    hubDesc: "Bidirectional real-time sync via authenticated WebSocket tunnel",
    hubNode: "Host Node",
    hubHeartbeat: "App-Ping Heartbeat",
    hubHeartbeatVal: "20s Keep-Alive Active",
    hubBackpressure: "Backpressure Guard",
    btnRefresh: "Ping Host",
    btnScan: "Scan QR",
    btnCode: "Enter Code",
    backBtn: "Back",
    swipeBackHint: "← Swipe from edge to return",
    nowRunningTitle: "Now Running Sessions",
    heroTitle: "Active Session Token Usage",
    metric1: "Active Windows",
    metric2: "Runs Completed",
    metric3: "Teammates Working",
    metric4: "Pending Actions (Ask)",
    askTitle: "Pending Approval (Ask)",
    askDesc: "Extension UI request requiring review:",
    askConfirm: "Approve",
    askReject: "Reject",
    attentionTitle: "System Attention",
    steerPlaceholder: "Steer selected window...",
    steerBtn: "Steer Window",
    secAppearance: "Appearance Mode",
    appearanceAuto: "Auto",
    appearanceLight: "Light",
    appearanceDark: "Dark",
    secLanguage: "System Language",
    secHub: "Server Management",
    secParams: "Performance",
    secVersion: "Version",
    versionApp: "Maestro Mobile Client",
    versionHost: "Desktop Host Server",
    versionPi: "Pi Agent Session Engine",
    versionFlow: "pi-maestro-flow Extension",
    versionCli: "Maestro CLI Tool",
    versionCompat: "Protocol Compatibility",
    versionCompatVal: "Compatible (v3.0.0)",
    allWindows: "All Windows",
    noWindows: "No window data",
    waitingHostPush: "Waiting for host push",
    noAlerts: "No alerts",
    alertCount: "alerts",
    confirm: "Confirm",
    cancel: "Cancel",
    apply: "Apply",
    selectModel: "Select Model",
    linesOutput: "lines",
    fullscreen: "Fullscreen",
    close: "Close",
    enterPairCode: "Enter 8-digit Pair Code",
    pairCodeHint: "Run /maestro-mobile qr on Mac terminal to get 8-digit code",
    scanQrTitle: "Scan Pairing QR Code",
    alignQrHint: "Point camera at QR code on PC terminal",
    cameraPermRequired: "Camera permission required to scan QR code",
    cameraPermHint: "QR code is shown after running /maestro-mobile qr on PC",
    grantCamera: "Grant Permission",
    goToSettings: "Open Settings",
    selectIpTitle: "Select Address to Connect",
    selectIpHint: "Select an IP address and tap next.",
    btnNext: "Next",
    btnRescan: "Rescan",
    connectingHost: "Connecting to host...",
    savingHost: "Saving pairing...",
    saveParams: "Save Settings",
    notifAttentionLabel: "Attention Haptic Feedback",
    notifAttentionDesc: "Gentle vibration when Ask review arrives",
    wifiOnlyLabel: "Large History on Wi-Fi Only",
    wifiOnlyDesc: "Save mobile cellular data",
    confirmConnect: "Connect",
    sendTo: "Send to",
    sendSupervisionMsg: "Send supervisor message",
    unnamedWindow: "Unnamed Window",
    unknownPath: "Unknown path",
    noWindowsDesc: "Waiting for host monitor telemetry",
    modelWindow: "Max Window",
  },
};

function detectSystemLanguage(): Language {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    if (locale.startsWith("zh")) return "zh";
  } catch {}
  return "zh"; // 默认中文友好
}

const LANG_KEY = "maestro-mobile.language";

interface I18nContextValue {
  lang: Language;
  langChoice: LanguageChoice;
  t: I18nDictionary;
  setLanguageChoice: (choice: LanguageChoice) => void;
  toggleLanguage: () => void;
}

const I18nContext = createContext<I18nContextValue>({
  lang: "zh",
  langChoice: "auto",
  t: DICTIONARIES.zh,
  setLanguageChoice: () => {},
  toggleLanguage: () => {},
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [langChoice, setLangChoice] = useState<LanguageChoice>("auto");
  const [lang, setLang] = useState<Language>(detectSystemLanguage());

  useEffect(() => {
    void AsyncStorage.getItem(LANG_KEY).then((saved) => {
      if (saved === "auto" || saved === "zh" || saved === "en") {
        setLangChoice(saved as LanguageChoice);
        if (saved === "auto") {
          setLang(detectSystemLanguage());
        } else {
          setLang(saved as Language);
        }
      }
    });
  }, []);

  const setLanguageChoice = useCallback((choice: LanguageChoice) => {
    setLangChoice(choice);
    if (choice === "auto") {
      setLang(detectSystemLanguage());
    } else {
      setLang(choice);
    }
    void AsyncStorage.setItem(LANG_KEY, choice);
  }, []);

  const toggleLanguage = useCallback(() => {
    const next = lang === "zh" ? "en" : "zh";
    setLanguageChoice(next);
  }, [lang, setLanguageChoice]);

  const value = {
    lang,
    langChoice,
    t: DICTIONARIES[lang],
    setLanguageChoice,
    toggleLanguage,
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** 通用双语相对时间格式化：刚刚 / {m} 分钟前 / {h} 小时前 / {d} 天前 */
export function formatRelativeTime(dateStr: string | undefined | null, t: I18nDictionary): string {
  if (!dateStr) return t.timeUnknown;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return t.timeUnknown;
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return t.justNow;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} ${t.minutesAgo}`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} ${t.hoursAgo}`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} ${t.daysAgo}`;
}
