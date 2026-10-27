#!/bin/bash
# 冒烟测试：模拟 fnOS 安装布局，验证生命周期、unix socket、HTTP 接口与 WebSocket 升级。
#
# 不需要安装 .fpk，也不需要 root：用一个临时目录模拟 /var/apps/<app>/{target,var,home}。

set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${ROOT}"

APP_NAME="nas-webterm"
PREFIX="/app/${APP_NAME}"
TMP_DIR="$(mktemp -d)"
trap 'cleanup' EXIT

PASS=0
FAIL=0

cleanup() {
    if [ -f "${TMP_DIR}/var/webterm.pid" ]; then
        kill "$(cat "${TMP_DIR}/var/webterm.pid" 2>/dev/null)" 2>/dev/null || true
    fi
    rm -rf "${TMP_DIR}"
}

check() {
    local name="$1" ok="$2" detail="${3:-}"
    if [ "${ok}" = "1" ]; then
        PASS=$((PASS + 1))
        printf '\033[32m✓\033[0m %s  %s\n' "${name}" "${detail}"
    else
        FAIL=$((FAIL + 1))
        printf '\033[31m✗\033[0m %s  %s\n' "${name}" "${detail}"
    fi
}

fail_exit() {
    printf '\033[31m✗ %s\033[0m\n' "$1" >&2
    exit 1
}

# --- 准备模拟安装布局 -------------------------------------------------------
ARCH="$(uname -m)"
case "${ARCH}" in
    x86_64) ARCH_TAG="x86_64" ;;
    aarch64 | arm64) ARCH_TAG="aarch64" ;;
    *) ARCH_TAG="${ARCH}" ;;
esac

SRC_BIN="${WT_BIN:-${ROOT}/rust/target/release/nas-webterm}"
[ -x "${SRC_BIN}" ] || fail_exit "未找到后端二进制 ${SRC_BIN}，请先执行 cargo build --release"

mkdir -p "${TMP_DIR}/target/server" "${TMP_DIR}/target/ui" "${TMP_DIR}/var" "${TMP_DIR}/home" "${TMP_DIR}/tmp"
cp "${SRC_BIN}" "${TMP_DIR}/target/server/nas-webterm-${ARCH_TAG}"
cp -r "${ROOT}/app/ui/." "${TMP_DIR}/target/ui/"

export TRIM_APPDEST="${TMP_DIR}/target"
export TRIM_PKGVAR="${TMP_DIR}/var"
export TRIM_PKGHOME="${TMP_DIR}/home"
export TRIM_PKGTMP="${TMP_DIR}/tmp"
export TRIM_APPVER="1.0.0"
export TRIM_USERNAME=""
export TRIM_GID=""

# 用当前用户可访问的目录做工作目录（root 环境下默认就是 /root）
printf 'DEFAULT_SHELL=%s\n' "/bin/bash" > "${TMP_DIR}/var/settings.env"
printf 'DEFAULT_CWD=%s\n' "${TMP_DIR}" >> "${TMP_DIR}/var/settings.env"
printf 'STARTUP_COMMAND=%s\n' "" >> "${TMP_DIR}/var/settings.env"
printf 'IDLE_MINUTES=%s\n' "5" >> "${TMP_DIR}/var/settings.env"
printf 'MAX_SESSIONS=%s\n' "4" >> "${TMP_DIR}/var/settings.env"
printf 'STRICT_ADMIN=%s\n' "true" >> "${TMP_DIR}/var/settings.env"

SOCKET="${TRIM_APPDEST}/app.sock"

# --- 1. 启动 ----------------------------------------------------------------
"${ROOT}/cmd/main" start >/dev/null 2>&1
check "cmd/main start 成功" "$([ $? -eq 0 ] && echo 1 || echo 0)" ""

# --- 2. status 运行中返回 0 -------------------------------------------------
"${ROOT}/cmd/main" status >/dev/null 2>&1
check "cmd/main status 运行中返回 0" "$([ $? -eq 0 ] && echo 1 || echo 0)" ""

# --- 3. 幂等：重复 start 不应产生第二个进程 ---------------------------------
PID_FIRST="$(cat "${TMP_DIR}/var/webterm.pid" 2>/dev/null)"
"${ROOT}/cmd/main" start >/dev/null 2>&1
PID_SECOND="$(cat "${TMP_DIR}/var/webterm.pid" 2>/dev/null)"
check "重复 start 幂等（pid 不变）" "$([ -n "${PID_FIRST}" ] && [ "${PID_FIRST}" = "${PID_SECOND}" ] && echo 1 || echo 0)" \
    "pid=${PID_FIRST}"

# --- 4. socket 存在且权限收紧 ----------------------------------------------
check "unix socket 已创建" "$([ -S "${SOCKET}" ] && echo 1 || echo 0)" "${SOCKET}"
SOCKET_MODE="$(stat -c '%a' "${SOCKET}" 2>/dev/null || echo '?')"
check "socket 权限为 600" "$([ "${SOCKET_MODE}" = "600" ] && echo 1 || echo 0)" "mode=${SOCKET_MODE}"

# --- 5. 首页渲染（网关前缀已注入） ------------------------------------------
HTML="$(curl -s --max-time 10 --unix-socket "${SOCKET}" "http://localhost${PREFIX}/" 2>/dev/null)"
check "首页可访问" "$([ -n "${HTML}" ] && echo 1 || echo 0)" ""
check "首页注入了网关前缀" "$(printf '%s' "${HTML}" | grep -q "${PREFIX}/assets/" && echo 1 || echo 0)" ""
check "首页没有未替换的占位符" "$(printf '%s' "${HTML}" | grep -q '__FN_BASE_RAW__' && echo 0 || echo 1)" ""

# --- 6. 静态资源 ------------------------------------------------------------
ASSET="$(printf '%s' "${HTML}" | grep -o "${PREFIX}/assets/[^\"]*\.js" | head -n1)"
if [ -n "${ASSET}" ]; then
    ASSET_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --unix-socket "${SOCKET}" "http://localhost${ASSET}" 2>/dev/null)"
    check "前端 JS 资源可访问" "$([ "${ASSET_CODE}" = "200" ] && echo 1 || echo 0)" "${ASSET} -> ${ASSET_CODE}"
else
    check "前端 JS 资源可访问" "0" "未在首页找到资源路径"
fi

# --- 7. REST 接口 -----------------------------------------------------------
HEALTH="$(curl -s --max-time 10 --unix-socket "${SOCKET}" -H 'X-Trim-Username: admin' -H 'X-Trim-Isadmin: true' "http://localhost${PREFIX}/api/healthz" 2>/dev/null)"
check "GET /api/healthz 返回 ok" "$(printf '%s' "${HEALTH}" | grep -q '"ok":true' && echo 1 || echo 0)" "${HEALTH:0:80}"

CONFIG="$(curl -s --max-time 10 --unix-socket "${SOCKET}" -H 'X-Trim-Username: admin' -H 'X-Trim-Isadmin: true' "http://localhost${PREFIX}/api/config" 2>/dev/null)"
check "GET /api/config 返回 shell 配置" "$(printf '%s' "${CONFIG}" | grep -q '"shell"' && echo 1 || echo 0)" "${CONFIG:0:80}"

# --- 8. 管理员校验 ----------------------------------------------------------
DENIED="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --unix-socket "${SOCKET}" -H 'X-Trim-Username: guest' -H 'X-Trim-Isadmin: false' "http://localhost${PREFIX}/api/healthz" 2>/dev/null)"
check "非管理员被拒绝（403）" "$([ "${DENIED}" = "403" ] && echo 1 || echo 0)" "status=${DENIED}"

# --- 9. WebSocket 升级 ------------------------------------------------------
WS_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --http1.1 --unix-socket "${SOCKET}" \
    -H 'X-Trim-Username: admin' -H 'X-Trim-Isadmin: true' \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "http://localhost${PREFIX}/api/ws" 2>/dev/null)"
check "WebSocket 升级成功（101）" "$([ "${WS_CODE}" = "101" ] && echo 1 || echo 0)" "status=${WS_CODE}"

# --- 10. 路径穿越 -----------------------------------------------------------
TRAV="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --unix-socket "${SOCKET}" "http://localhost${PREFIX}/../../etc/passwd" 2>/dev/null)"
check "路径穿越被阻断（非 200）" "$([ "${TRAV}" != "200" ] && echo 1 || echo 0)" "status=${TRAV}"

# --- 11. 停止 ---------------------------------------------------------------
"${ROOT}/cmd/main" stop >/dev/null 2>&1
check "cmd/main stop 成功" "$([ $? -eq 0 ] && echo 1 || echo 0)" ""

"${ROOT}/cmd/main" status >/dev/null 2>&1
check "cmd/main status 停止后返回 3" "$([ $? -eq 3 ] && echo 1 || echo 0)" ""

check "停止后 socket 已清理" "$([ ! -S "${SOCKET}" ] && echo 1 || echo 0)" ""
check "停止后 pid 文件已清理" "$([ ! -f "${TMP_DIR}/var/webterm.pid" ] && echo 1 || echo 0)" ""

if [ -n "${PID_FIRST}" ] && kill -0 "${PID_FIRST}" 2>/dev/null; then
    check "停止后进程已退出" "0" "pid=${PID_FIRST} 仍在运行"
else
    check "停止后进程已退出" "1" ""
fi

printf '\n结果：%d 通过，%d 失败\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ] || exit 1
