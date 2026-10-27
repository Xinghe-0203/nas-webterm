#!/bin/bash
# 安装模拟：把 .fpk 按应用中心的真实布局铺开，跑一遍安装回调 + 启停 + 网关请求。
#
# 与 tools/smoke-test.sh 的区别：冒烟测试直接用源码目录里的二进制；
# 这里用的是**打包产物**，能发现「包内目录名/路径与 cmd/main 不一致」这类问题。
#
# 用法：./tools/install-sim.sh [dist/nas-webterm-1.0.0.fpk]

set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
FPK="${1:-}"
if [ -z "${FPK}" ]; then
    FPK="$(ls -1t "${ROOT}"/dist/*.fpk 2>/dev/null | head -n1)"
fi
[ -n "${FPK}" ] && [ -f "${FPK}" ] || { echo "找不到 .fpk，请先运行 ./build.sh" >&2; exit 1; }

APP_NAME="nas-webterm"
PREFIX="/app/${APP_NAME}"
SIM="$(mktemp -d)"
trap 'cleanup' EXIT

PASS=0
FAIL=0
check() {
    local name="$1" ok="$2" detail="${3:-}"
    if [ "${ok}" = "1" ]; then
        PASS=$((PASS + 1)); printf '\033[32m✓\033[0m %s  %s\n' "${name}" "${detail}"
    else
        FAIL=$((FAIL + 1)); printf '\033[31m✗\033[0m %s  %s\n' "${name}" "${detail}"
    fi
}

cleanup() {
    if [ -f "${SIM}/var/webterm.pid" ]; then
        kill "$(cat "${SIM}/var/webterm.pid" 2>/dev/null)" 2>/dev/null || true
    fi
    pkill -f "${SIM}/target/server/nas-webterm" 2>/dev/null || true
    rm -rf "${SIM}"
}

echo "使用产物：${FPK}"
echo "模拟根目录：${SIM}"

# --- 按应用中心的布局铺开 ---------------------------------------------------
mkdir -p "${SIM}/pkg" "${SIM}/target" "${SIM}/var" "${SIM}/home" "${SIM}/tmp" "${SIM}/etc"
tar -xzf "${FPK}" -C "${SIM}/pkg"
check "包内包含 manifest 与 cmd/" "$([ -f "${SIM}/pkg/manifest" ] && [ -d "${SIM}/pkg/cmd" ] && echo 1 || echo 0)" ""
tar -xzf "${SIM}/pkg/app.tgz" -C "${SIM}/target"
check "载荷解包到 target/（含 server + ui）" \
    "$([ -x "${SIM}/target/server/nas-webterm-$(uname -m | sed 's/arm64/aarch64/')" ] && [ -f "${SIM}/target/ui/index.html" ] && echo 1 || echo 0)" ""

chmod 755 "${SIM}"/pkg/cmd/* 2>/dev/null

export TRIM_APPDEST="${SIM}/target"
export TRIM_PKGVAR="${SIM}/var"
export TRIM_PKGHOME="${SIM}/home"
export TRIM_PKGTMP="${SIM}/tmp"
export TRIM_PKGETC="${SIM}/etc"
export TRIM_APPNAME="${APP_NAME}"
export TRIM_APPVER="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' "${SIM}/pkg/manifest" | head -n1 | tr -d '[:space:]')"
export TRIM_USERNAME=""
export TRIM_GID=""

# 安装向导默认值（模拟用户直接点下一步）
export wizard_default_shell="/bin/bash"
export wizard_default_cwd="${HOME}"
export wizard_startup_command=""
export wizard_idle_minutes="10"
export wizard_max_sessions="8"
export wizard_strict_admin="true"

# --- 安装回调 ---------------------------------------------------------------
"${SIM}/pkg/cmd/install_init" >/dev/null 2>&1
check "install_init 执行成功" "$([ $? -eq 0 ] && echo 1 || echo 0)" ""
"${SIM}/pkg/cmd/install_callback" >/dev/null 2>&1
check "install_callback 执行成功" "$([ $? -eq 0 ] && echo 1 || echo 0)" ""
check "settings.env 已持久化" "$([ -f "${SIM}/var/settings.env" ] && echo 1 || echo 0)" ""
check "settings.env 不含向导原始字段" \
    "$(grep -q 'wizard_' "${SIM}/var/settings.env" 2>/dev/null && echo 0 || echo 1)" ""

# --- 启动 -------------------------------------------------------------------
"${SIM}/pkg/cmd/main" start >/dev/null 2>&1
check "cmd/main start 成功" "$([ $? -eq 0 ] && echo 1 || echo 0)" ""

SOCKET="${TRIM_APPDEST}/app.sock"
check "app.sock 已创建" "$([ -S "${SOCKET}" ] && echo 1 || echo 0)" ""

# --- 网关请求 ---------------------------------------------------------------
HDR=(-H 'X-Trim-Username: admin' -H 'X-Trim-Isadmin: true' -H 'Host: nas:5666')

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --unix-socket "${SOCKET}" "${HDR[@]}" "http://localhost${PREFIX}/")"
check "网关访问首页 200" "$([ "${CODE}" = "200" ] && echo 1 || echo 0)" "status=${CODE}"

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --unix-socket "${SOCKET}" "${HDR[@]}" "http://localhost${PREFIX}/api/healthz")"
check "网关访问 healthz 200" "$([ "${CODE}" = "200" ] && echo 1 || echo 0)" "status=${CODE}"

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --http1.1 --unix-socket "${SOCKET}" "${HDR[@]}" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "http://localhost${PREFIX}/api/ws")"
check "网关 WebSocket 升级 101" "$([ "${CODE}" = "101" ] && echo 1 || echo 0)" "status=${CODE}"

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --unix-socket "${SOCKET}" \
    -H 'X-Trim-Username: guest' -H 'X-Trim-Isadmin: false' "http://localhost${PREFIX}/api/healthz")"
check "非管理员 403" "$([ "${CODE}" = "403" ] && echo 1 || echo 0)" "status=${CODE}"

# --- 停止与卸载 -------------------------------------------------------------
"${SIM}/pkg/cmd/main" stop >/dev/null 2>&1
"${SIM}/pkg/cmd/main" status >/dev/null 2>&1
check "停止后 status 返回 3" "$([ $? -eq 3 ] && echo 1 || echo 0)" ""
check "停止后 socket 已清理" "$([ ! -S "${SOCKET}" ] && echo 1 || echo 0)" ""

export wizard_delete_data="true"
"${SIM}/pkg/cmd/uninstall_callback" >/dev/null 2>&1
check "uninstall_callback 删除数据" "$([ ! -f "${SIM}/var/settings.env" ] && echo 1 || echo 0)" ""

printf '\n结果：%d 通过，%d 失败\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ] || exit 1
