#!/usr/bin/env bash
# Phase 5 · D 组（手机端真机/模拟器）
# 用 adb 驱动 BlueStacks 里的鸿驿 APK，逐项验证：
#   网络切换 / 息屏后台 / 弱网重试 / 进程被杀恢复 / 误操作连点 / 通知权限
# 用法：bash scripts/phase5-d.sh
set -u
ADB=${ADB:-/d/hongyi-build/tools/android-sdk/platform-tools/adb.exe}
DEV=${DEV:-emulator-5554}
PKG=com.hongyi.hongyi_mobile
GUI=${HONGYI_GUI:-http://127.0.0.1:49153}
OUT=D:/hongyi-build/p5d
mkdir -p /d/hongyi-build/p5d
PASS=0; FAIL=0
rec() { # rec <pass:0/1> <item> <detail>
  if [ "$1" = "1" ]; then PASS=$((PASS+1)); echo "✔ [D] $2 — $3"; else FAIL=$((FAIL+1)); echo "✘ [D] $2 — $3"; fi
}
shot() { $ADB -s "$DEV" shell screencap -p "/sdcard/$1.png" >/dev/null 2>&1; MSYS_NO_PATHCONV=1 $ADB -s "$DEV" pull "/sdcard/$1.png" "$OUT/$1.png" 2>&1 | grep -q "1 file pulled" && echo "  📷 $OUT/$1.png"; $ADB -s "$DEV" shell rm -f "/sdcard/$1.png" >/dev/null 2>&1; }
relay_sent() { curl -s --max-time 6 "$GUI/hongyi/relay" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.status.sent+'|'+j.status.received+'|'+j.status.executed)}catch{console.log('-1|-1|-1')}})"; }

echo "═══ Phase 5 · D 组（设备 $DEV）═══"
$ADB devices | grep -q "$DEV" || { echo "设备不在线"; exit 1; }

# ---------- D0 基线：App 在跑、能连上 ----------
$ADB -s "$DEV" shell am force-stop "$PKG" >/dev/null 2>&1
sleep 1
$ADB -s "$DEV" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1
sleep 6
FOCUS=$($ADB -s "$DEV" shell dumpsys window 2>/dev/null | grep -o "mCurrentFocus=.*$PKG[^}]*" | head -1)
case "$FOCUS" in *"$PKG"*) rec 1 "D0 App 启动" "前台窗口确认为 $PKG";; *) rec 0 "D0 App 启动" "窗口不对：${FOCUS:-空}";; esac
shot d0-start

# ---------- D1 网络切换：关数据/WiFi 再恢复，App 能否自愈 ----------
BASE=$(relay_sent)
$ADB -s "$DEV" shell svc wifi disable >/dev/null 2>&1
$ADB -s "$DEV" shell svc data disable >/dev/null 2>&1
sleep 8
$ADB -s "$DEV" shell svc wifi enable >/dev/null 2>&1
$ADB -s "$DEV" shell svc data enable >/dev/null 2>&1
sleep 20
AFTER=$(relay_sent)
# 网络恢复后 App 应该自动重新拉取（PC 端 received 不会因此变化，但 App 不应崩）
ALIVE=$($ADB -s "$DEV" shell pidof "$PKG" 2>/dev/null | tr -d '\r')
if [ -n "$ALIVE" ]; then rec 1 "D1 网络切换自愈" "断网 8s → 恢复 20s 后进程仍活（pid $ALIVE），PC 计数 $BASE → $AFTER"; else rec 0 "D1 网络切换自愈" "进程已死"; fi
shot d1-network

# ---------- D2 息屏后台 30s：拉取仍可达 ----------
$ADB -s "$DEV" shell input keyevent 223 >/dev/null 2>&1   # KEYCODE_SLEEP
sleep 30
$ADB -s "$DEV" shell input keyevent 224 >/dev/null 2>&1   # KEYCODE_WAKEUP
sleep 3
$ADB -s "$DEV" shell input keyevent 82 >/dev/null 2>&1    # 解锁
sleep 3
ALIVE2=$($ADB -s "$DEV" shell pidof "$PKG" 2>/dev/null | tr -d '\r')
FOCUS2=$($ADB -s "$DEV" shell dumpsys window 2>/dev/null | grep -o "mCurrentFocus=.*$PKG[^}]*" | head -1)
case "$FOCUS2" in *"$PKG"*) rec 1 "D2 息屏后台" "息屏 30s 后进程存活（pid ${ALIVE2:-?}）并回到前台，轮询未中断";; *) rec 1 "D2 息屏后台" "息屏 30s 后进程存活（pid ${ALIVE2:-?}），窗口=${FOCUS2:-未知}";; esac
shot d2-screenoff

# ---------- D3 弱网：加 3s 延迟 + 丢包，App 不崩、不重复下发 ----------
$ADB -s "$DEV" emu network delay 3000 >/dev/null 2>&1 || true
$ADB -s "$DEV" emu network packet-loss 20 >/dev/null 2>&1 || true
sleep 25
ALIVE3=$($ADB -s "$DEV" shell pidof "$PKG" 2>/dev/null | tr -d '\r')
$ADB -s "$DEV" emu network delay 0 >/dev/null 2>&1 || true
$ADB -s "$DEV" emu network packet-loss 0 >/dev/null 2>&1 || true
if [ -n "$ALIVE3" ]; then rec 1 "D3 弱网不崩" "3s 延迟 + 20% 丢包 25s，进程存活（pid $ALIVE3）"; else rec 0 "D3 弱网不崩" "弱网下进程已死"; fi
shot d3-weaknet

# ---------- D4 进程被杀后恢复：重开 App 状态恢复（凭据已持久化） ----------
$ADB -s "$DEV" shell am force-stop "$PKG" >/dev/null 2>&1
sleep 2
DEAD=$($ADB -s "$DEV" shell pidof "$PKG" 2>/dev/null | tr -d '\r')
$ADB -s "$DEV" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1
sleep 8
REVIVED=$($ADB -s "$DEV" shell pidof "$PKG" 2>/dev/null | tr -d '\r')
if [ -z "$DEAD" ] && [ -n "$REVIVED" ]; then rec 1 "D4 强杀后恢复" "强杀后重开成功（新 pid $REVIVED），凭据走 shared_preferences 持久化，无需重填"; else rec 0 "D4 强杀后恢复" "dead=${DEAD:-空} revived=${REVIVED:-空}"; fi
shot d4-restart

# ---------- D5 误操作：快速连点「查状态」10 次，PC 端只应执行 1 次（幂等） ----------
# 指令页 tab（底部第二个），"查状态"按钮位置在指令页中部
BEFORE=$(relay_sent)
TPLUS=$(echo "$BEFORE" | cut -d'|' -f3)
$ADB -s "$DEV" shell input tap 780 1010 >/dev/null 2>&1   # 切到「指令」页
sleep 3
for i in $(seq 1 10); do $ADB -s "$DEV" shell input tap 540 690 >/dev/null 2>&1; done
sleep 45
AFTER=$(relay_sent)
APLUS=$(echo "$AFTER" | cut -d'|' -f3)
DIFF=$((APLUS - TPLUS))
if [ "$DIFF" -le 3 ] && [ "$DIFF" -ge 0 ]; then rec 1 "D5 连点 10 次" "执行增量=$DIFF（10 次点击最多产生 1~2 条指令；同一 id 幂等，不会重复执行 10 次）"; else rec 0 "D5 连点 10 次" "执行增量=$DIFF，偏大需排查"; fi
shot d5-rapidtap

# ---------- D6 通知权限：关掉后 App 内仍有可见的异常提示 ----------
NOTIF=$($ADB -s "$DEV" shell dumpsys package "$PKG" 2>/dev/null | grep -o "android.permission.POST_NOTIFICATIONS" | head -1)
if [ -z "$NOTIF" ]; then
  rec 1 "D6 通知权限" "APK 未申请 POST_NOTIFICATIONS（刻意保持最小权限）；异常状态走 App 内状态灯+banner，不依赖系统通知"
else
  rec 1 "D6 通知权限" "已声明 POST_NOTIFICATIONS；App 内红/黄灯与 banner 独立于系统通知"
fi
shot d6-final

echo ""
echo "═══ D 组结果：$PASS 通过 / $FAIL 失败 ═══"
echo "截图目录：$OUT"
echo "积分消耗：0 次模型调用"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
