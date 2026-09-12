#!/usr/bin/env bash
set -e

SIM_ID="ACDD28BF-256D-4513-B009-71226C6742A0"
OUT_VIDEO="/Users/isulewli/Projects/pi-maestro-app-party/recordings/maestro-mobile-v11-interactions.mp4"
TMP_VIDEO="/tmp/sim-demo.mp4"

rm -f "$TMP_VIDEO" "$OUT_VIDEO"

echo "[1/5] 确保 App 处于前台运行中..."
xcrun simctl launch "$SIM_ID" dev.maestromobile.app
sleep 2

echo "[2/5] 启动模拟器高清录屏..."
xcrun simctl io "$SIM_ID" recordVideo "$TMP_VIDEO" &
RECORD_PID=$!

sleep 2

echo "[3/5] 激活 Simulator 并计算窗口与屏幕坐标..."
osascript -e 'tell application "Simulator" to activate'
sleep 1

POS_DATA=$(osascript -e '
tell application "System Events"
  tell process "Simulator"
    set pos to position of window 1
    set sz to size of window 1
    return (item 1 of pos as text) & " " & (item 2 of pos as text) & " " & (item 1 of sz as text) & " " & (item 2 of sz as text)
  end tell
end tell
')

read W_X W_Y W_W W_H <<< "$POS_DATA"
echo "模拟器窗口: X=$W_X Y=$W_Y W=$W_W H=$W_H"

# 实际屏幕区域（去黑边与外壳）
CONTENT_X=$((W_X + 25))
CONTENT_Y=$((W_Y + 55))
CONTENT_W=$((W_W - 50))
CONTENT_H=$((W_H - 75))

MID_X=$((CONTENT_X + CONTENT_W / 2))
MID_Y=$((CONTENT_Y + CONTENT_H / 2))

echo "[4/5] 自动化执行手势交互流程..."
# 1. 停留在工作台展示 PulsingDot 呼吸绿光与 Bento 仪表盘
sleep 3

# 2. 从右向左横向滑动手势 (工作台 -> 会话列表)
echo "手势: 向左横滑切换 Tab 到【会话】..."
./scripts/sim_touch drag $((MID_X + 110)) $MID_Y $((MID_X - 110)) $MID_Y 25 350
sleep 3

# 3. 从右向左横向滑动手势 (会话列表 -> 监控)
echo "手势: 向左横滑切换 Tab 到【监控】..."
./scripts/sim_touch drag $((MID_X + 110)) $MID_Y $((MID_X - 110)) $MID_Y 25 350
sleep 3

# 4. 点击监控卡片弹出手势 Bottom Sheet
echo "点击监控卡片弹出带 HandleBar 的 Bottom Sheet..."
./scripts/sim_touch click $MID_X $((CONTENT_Y + 230))
sleep 3

# 5. 在 Bottom Sheet 把手处向下滑动拖拽关闭 (Drag-to-dismiss)
echo "手势: 在 Bottom Sheet 把手处向下滑动关闭..."
SHEET_HANDLE_Y=$((CONTENT_Y + CONTENT_H - 150))
./scripts/sim_touch drag $MID_X $SHEET_HANDLE_Y $MID_X $((SHEET_HANDLE_Y + 120)) 25 300
sleep 3

# 6. 点击底栏“会话”Tab
echo "点击底栏切换到【会话】..."
TAB_SESSIONS_X=$((CONTENT_X + CONTENT_W * 3 / 8))
TAB_Y=$((CONTENT_Y + CONTENT_H - 30))
./scripts/sim_touch click $TAB_SESSIONS_X $TAB_Y
sleep 2

# 7. 点击会话卡片进入会话详情
echo "点击会话卡片进入详细聊天页..."
./scripts/sim_touch click $MID_X $((CONTENT_Y + 200))
sleep 3

# 8. 屏幕左边缘向右拖拽 (原生边缘滑动返回退出手势)
echo "手势: 屏幕左边缘向右滑动返回退出会话..."
LEFT_EDGE_X=$((CONTENT_X + 10))
./scripts/sim_touch drag $LEFT_EDGE_X $MID_Y $((LEFT_EDGE_X + 220)) $MID_Y 30 400
sleep 3

echo "[5/5] 停止录屏并转存 MP4..."
kill -INT $RECORD_PID || true
wait $RECORD_PID 2>/dev/null || true
sleep 2

if [ -f "$TMP_VIDEO" ]; then
  cp "$TMP_VIDEO" "$OUT_VIDEO"
  echo "录屏已成功交付至: $OUT_VIDEO"
  ls -lh "$OUT_VIDEO"
else
  echo "未找到录屏临时文件 $TMP_VIDEO"
  exit 1
fi
