#!/bin/bash
# Web 终端（nas-webterm）构建脚本
#
# 流程：清理 → Rust 编译（x86_64 + aarch64）→ 前端构建 → 语法/JSON 检查 → 权限归一化
#       → 冒烟测试 → fnpack 打包 → 产物校验
# 产物：dist/nas-webterm-<version>.fpk（飞牛应用中心「手动安装」）
#
# 依赖：bash、cargo（rustup）、node（18+）、curl、fnpack。
# 交叉编译 aarch64 需要 gcc-aarch64-linux-gnu（Debian/Ubuntu：apt install gcc-aarch64-linux-gnu）。
#
# 用法：
#   ./build.sh                   完整构建
#   ./build.sh --no-test         跳过冒烟测试
#   ./build.sh --with-browser    额外跑 headless 浏览器验证（需要 chromium）
#   ./build.sh --arch x86_64     只构建指定架构（x86_64 / aarch64 / both，默认 both）

set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "${ROOT}"

RUN_SMOKE=1
RUN_BROWSER=0
ARCHS="both"

while [ $# -gt 0 ]; do
    case "$1" in
        --no-test) RUN_SMOKE=0 ;;
        --with-browser) RUN_BROWSER=1 ;;
        --arch)
            shift
            ARCHS="${1:-both}"
            ;;
        -h | --help)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        *)
            echo "未知参数: $1" >&2
            exit 1
            ;;
    esac
    shift
done

APP_NAME="$(sed -n 's/^appname[[:space:]]*=[[:space:]]*//p' manifest | head -n1 | tr -d '[:space:]')"
APP_VER="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' manifest | head -n1 | tr -d '[:space:]')"
OUT_DIR="${ROOT}/dist"
OUT_FILE="${OUT_DIR}/${APP_NAME}-${APP_VER}.fpk"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() {
    printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2
    exit 1
}

find_node() {
    local candidate
    for candidate in "${NODE_BIN:-}" /var/apps/nodejs_v24/target/bin/node \
        /var/apps/nodejs_v22/target/bin/node /usr/local/bin/node /usr/bin/node; do
        if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
            printf '%s' "${candidate}"
            return 0
        fi
    done
    candidate="$(command -v node 2>/dev/null || true)"
    [ -n "${candidate}" ] && [ -x "${candidate}" ] && printf '%s' "${candidate}"
}

find_cargo() {
    local candidate
    for candidate in "${CARGO_BIN:-}" "${HOME}/.cargo/bin/cargo" /usr/local/bin/cargo /usr/bin/cargo; do
        if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
            printf '%s' "${candidate}"
            return 0
        fi
    done
    candidate="$(command -v cargo 2>/dev/null || true)"
    [ -n "${candidate}" ] && printf '%s' "${candidate}"
}

find_fnpack() {
    local candidate
    for candidate in "${FNPACK_BIN:-}" "${ROOT}/tools/fnpack" "$(command -v fnpack 2>/dev/null || true)"; do
        if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
            printf '%s' "${candidate}"
            return 0
        fi
    done
    echo "未找到 fnpack，正在从飞牛官方地址下载（约 4MB）…" >&2
    mkdir -p "${ROOT}/tools"
    case "$(uname -m)" in
        aarch64 | arm64)
            curl -fsSL -o "${ROOT}/tools/fnpack" \
                https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-arm ||
                fail "fnpack 下载失败，请手动下载后放到 tools/fnpack 或设置 FNPACK_BIN"
            ;;
        *)
            curl -fsSL -o "${ROOT}/tools/fnpack" \
                https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64 ||
                fail "fnpack 下载失败，请手动下载后放到 tools/fnpack 或设置 FNPACK_BIN"
            ;;
    esac
    chmod 755 "${ROOT}/tools/fnpack"
    printf '%s' "${ROOT}/tools/fnpack"
}

NODE_BIN="$(find_node || true)"
CARGO="$(find_cargo || true)"
[ -n "${NODE_BIN}" ] || fail "未找到 Node.js，无法构建前端"
[ -n "${CARGO}" ] || fail "未找到 cargo，请先安装 Rust 工具链（https://rustup.rs）"

export PATH="$(dirname "${CARGO}"):${PATH}"

# ---------------------------------------------------------------------------
step "1/9 清理旧产物"
find "${ROOT}" -name '.DS_Store' -delete
rm -rf "${ROOT}/app/server" "${ROOT}/app/bin"
mkdir -p "${ROOT}/app/server" "${OUT_DIR}"
echo "清理完成"

# ---------------------------------------------------------------------------
step "2/9 编译 Rust 后端"

build_arch() {
    local target="$1" out="$2" cross_cc="$3"
    echo "--- 编译 ${target} ---"
    if [ "${target}" = "x86_64-unknown-linux-gnu" ]; then
        if ! rustup target list --installed 2>/dev/null | grep -qx "${target}"; then
            rustup target add "${target}" >/dev/null 2>&1 || true
        fi
        (cd "${ROOT}/rust" && "${CARGO}" build --release --target "${target}" >/dev/null) ||
            fail "编译 ${target} 失败"
    else
        if ! rustup target list --installed 2>/dev/null | grep -qx "${target}"; then
            rustup target add "${target}" >/dev/null 2>&1 || fail "添加 Rust 目标 ${target} 失败"
        fi
        command -v "${cross_cc}" >/dev/null 2>&1 ||
            fail "缺少交叉编译器 ${cross_cc}，请安装 gcc-aarch64-linux-gnu"
        local cc_var
        cc_var="$(echo "${target}" | tr 'a-z-' 'A-Z_')"
        (cd "${ROOT}/rust" && env "CARGO_TARGET_${cc_var}_LINKER=${cross_cc}" \
            "CARGO_TARGET_${cc_var}_CC=${cross_cc}" \
            "${CARGO}" build --release --target "${target}" >/dev/null) ||
            fail "编译 ${target} 失败"
    fi
    local bin="${ROOT}/rust/target/${target}/release/${APP_NAME}"
    [ -x "${bin}" ] || fail "未找到编译产物 ${bin}"
    cp "${bin}" "${ROOT}/app/server/${out}"
    chmod 755 "${ROOT}/app/server/${out}"
    echo "  → app/server/${out}  $(du -h "${ROOT}/app/server/${out}" | awk '{print $1}')"
}

case "${ARCHS}" in
    x86_64) build_arch "x86_64-unknown-linux-gnu" "nas-webterm-x86_64" "gcc" ;;
    aarch64) build_arch "aarch64-unknown-linux-gnu" "nas-webterm-aarch64" "aarch64-linux-gnu-gcc" ;;
    both | all)
        build_arch "x86_64-unknown-linux-gnu" "nas-webterm-x86_64" "gcc"
        build_arch "aarch64-unknown-linux-gnu" "nas-webterm-aarch64" "aarch64-linux-gnu-gcc"
        ;;
    *)
        fail "未知架构：${ARCHS}（可选 x86_64 / aarch64 / both）"
        ;;
esac

# ---------------------------------------------------------------------------
step "3/9 构建前端"
(
    cd "${ROOT}/web"
    if [ ! -d node_modules ]; then
        echo "首次构建，安装前端依赖…"
        npm install --no-audit --no-fund --loglevel=error
    fi
    npx tsc --noEmit || fail "TypeScript 类型检查失败"
    npx vite build >/dev/null || fail "前端构建失败"
    node scripts/postbuild.mjs
)

[ -f "${ROOT}/app/ui/index.html" ] || fail "前端产物缺失"
grep -q '__FN_BASE_RAW__' "${ROOT}/app/ui/index.html" ||
    fail "前端资源路径没有改写成 __FN_BASE_RAW__ 占位符"

# ---------------------------------------------------------------------------
step "4/9 校验源文件（JS/Shell/JSON）"
for file in tools/*.sh cmd/*; do
    [ -f "${file}" ] || continue
    bash -n "${file}" || fail "Shell 语法错误: ${file}"
done
for file in tools/*.mjs; do
    [ -f "${file}" ] || continue
    "${NODE_BIN}" --check "${file}" || fail "JS 语法错误: ${file}"
done
"${NODE_BIN}" -e '
const fs = require("fs");
const files = ["app/ui/config", "config/privilege", "config/resource",
               "wizard/install", "wizard/upgrade", "wizard/uninstall", "wizard/config"]
  .filter((f) => fs.existsSync(f));
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  if (f.startsWith("wizard/")) {
    if (!Array.isArray(data) || data.length === 0) throw new Error(f + " 必须是非空数组");
    for (const page of data) {
      for (const item of page.items || []) {
        if (item.initValue !== undefined && typeof item.initValue !== "string") {
          throw new Error(`${f}: 字段 ${item.field || item.type} 的 initValue 必须是字符串`);
        }
      }
    }
  }
}
' || fail "JSON 配置校验失败"
echo "语法与配置检查通过"

# ---------------------------------------------------------------------------
step "5/9 归一化文件权限（644 / 755）"
find app cmd config wizard -type d -exec chmod 755 {} +
find app cmd config wizard -type f -exec chmod 644 {} +
chmod 755 cmd/*
chmod 755 app/server/*
chmod 644 manifest ICON.PNG ICON_256.PNG
[ ! -f LICENSE ] || chmod 644 LICENSE
echo "权限归一化完成"

# ---------------------------------------------------------------------------
step "6/9 冒烟测试"
if [ "${RUN_SMOKE}" -eq 1 ]; then
    # 冒烟测试用本机架构的二进制
    HOST_ARCH="$(uname -m)"
    case "${HOST_ARCH}" in
        x86_64) TEST_BIN="app/server/nas-webterm-x86_64" ;;
        aarch64 | arm64) TEST_BIN="app/server/nas-webterm-aarch64" ;;
        *) TEST_BIN="app/server/nas-webterm-x86_64" ;;
    esac
    [ -x "${ROOT}/${TEST_BIN}" ] || fail "本机架构二进制缺失：${TEST_BIN}"
    WT_BIN="${ROOT}/${TEST_BIN}" NODE_BIN="${NODE_BIN}" "${ROOT}/tools/smoke-test.sh" ||
        fail "冒烟测试失败"
else
    echo "已通过 --no-test 跳过"
fi

# ---------------------------------------------------------------------------
step "7/9 浏览器验证"
if [ "${RUN_BROWSER}" -eq 1 ]; then
    CHROME_BIN="${CHROME_BIN:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}"
    if [ -z "${CHROME_BIN}" ]; then
        echo "未找到 chromium，跳过浏览器验证" >&2
    else
        DEV_PORT="${DEV_PORT:-18098}"
        "${ROOT}/app/server/nas-webterm-$(uname -m | sed 's/arm64/aarch64/')" \
            --host 127.0.0.1 --port "${DEV_PORT}" \
            --ui-dir "${ROOT}/app/ui" --gateway-prefix "/app/${APP_NAME}" \
            --app-name "${APP_NAME}" --version "${APP_VER}" \
            --cwd "${HOME}" --require-admin false \
            >"${OUT_DIR}/.browser-test.log" 2>&1 &
        DEV_PID="$!"
        trap 'kill "${DEV_PID}" 2>/dev/null || true' EXIT
        sleep 3
        CHROME_BIN="${CHROME_BIN}" "${NODE_BIN}" "${ROOT}/tools/verify-browser.mjs" \
            --url "http://127.0.0.1:${DEV_PORT}/app/${APP_NAME}/" \
            --title "Web" --expect ".xterm" \
            --api "./api/healthz" --ws "/app/${APP_NAME}/api/ws" \
            --type "echo build-check-ok" \
            --screenshot "${ROOT}/docs/screenshots/build-verify.png" || fail "浏览器验证失败"
        # VT 兼容性回归：DECRQM 等终端能力查询序列必须不崩解析器
        CHROME_BIN="${CHROME_BIN}" "${NODE_BIN}" "${ROOT}/tools/verify-vt.mjs" \
            --url "http://127.0.0.1:${DEV_PORT}/app/${APP_NAME}/" \
            --screenshot "${ROOT}/docs/screenshots" --name vt-regression ||
            fail "VT 兼容性回归测试失败"

        # 全功能验证：尺寸同步、粘贴、中文、真彩色、信号、隔离、容量、重连
        "${NODE_BIN}" "${ROOT}/tools/verify-features.mjs" \
            --url "http://127.0.0.1:${DEV_PORT}/app/${APP_NAME}/" ||
            fail "全功能验证失败"

        # 泄漏验证（后端）：RSS / fd / 线程 / 僵尸进程
        "${NODE_BIN}" "${ROOT}/tools/verify-leaks.mjs" \
            --url "http://127.0.0.1:${DEV_PORT}/app/${APP_NAME}/" \
            --pid "${DEV_PID}" --rounds 30 ||
            fail "后端泄漏验证失败"

        # 泄漏验证（前端）：JS 堆 / DOM 节点 / 终端实例
        CHROME_BIN="${CHROME_BIN}" "${NODE_BIN}" "${ROOT}/tools/verify-front-leaks.mjs" \
            --url "http://127.0.0.1:${DEV_PORT}/app/${APP_NAME}/" --rounds 20 ||
            fail "前端泄漏验证失败"

        # 全屏 TUI：断线重连后画面必须能正确重建
        "${NODE_BIN}" "${ROOT}/tools/verify-reconnect-tui.mjs" \
            --url "http://127.0.0.1:${DEV_PORT}/app/${APP_NAME}/" --cmd htop ||
            fail "TUI 断线重连验证失败"

        kill "${DEV_PID}" 2>/dev/null || true
        rm -f "${OUT_DIR}/.browser-test.log"
    fi
else
    echo "已跳过（加 --with-browser 可开启）"
fi

# ---------------------------------------------------------------------------
step "8/9 打包 .fpk"
FNPACK="$(find_fnpack)"
echo "fnpack: ${FNPACK}"
"${FNPACK}" build
[ -f "${ROOT}/${APP_NAME}.fpk" ] || fail "fnpack 未生成 ${APP_NAME}.fpk"
mv -f "${ROOT}/${APP_NAME}.fpk" "${OUT_FILE}"

# ---------------------------------------------------------------------------
step "9/9 校验产物"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"; kill "${DEV_PID:-}" 2>/dev/null || true' EXIT
tar -xzf "${OUT_FILE}" -C "${TMP_DIR}" app.tgz manifest || fail "解包 .fpk 失败"

APP_MD5="$(md5sum "${TMP_DIR}/app.tgz" | awk '{print $1}')"
MANIFEST_MD5="$(sed -n 's/^checksum[[:space:]]*=[[:space:]]*//p' "${TMP_DIR}/manifest" | head -n1 | tr -d '[:space:]')"
[ -n "${MANIFEST_MD5}" ] || fail "manifest 中缺少 checksum 字段"
[ "${APP_MD5}" = "${MANIFEST_MD5}" ] || fail "checksum 校验失败：app.tgz=${APP_MD5} manifest=${MANIFEST_MD5}"

# 先落到文件再检查，避免 tar | grep -q 在 pipefail 下被 SIGPIPE 误判
LIST_FILE="${TMP_DIR}/entries.txt"
tar -tzf "${TMP_DIR}/app.tgz" > "${LIST_FILE}" || fail "读取 app.tgz 目录失败"

if grep -q '\.DS_Store' "${LIST_FILE}"; then
    fail "app.tgz 中残留 .DS_Store"
fi

# 双架构二进制都要在包里，且架构必须正确（防止拷串导致装上去跑不起来）
for arch in x86_64 aarch64; do
    grep -qx "server/nas-webterm-${arch}" "${LIST_FILE}" || fail "app.tgz 缺少 ${arch} 二进制"
done
APP_EXTRACT="${TMP_DIR}/app-extract"
mkdir -p "${APP_EXTRACT}"
tar -xzf "${TMP_DIR}/app.tgz" -C "${APP_EXTRACT}" server 2>/dev/null || true
if command -v file >/dev/null 2>&1; then
    file "${APP_EXTRACT}/server/nas-webterm-x86_64" 2>/dev/null | grep -q 'x86-64' ||
        fail "server/nas-webterm-x86_64 不是 x86-64 架构"
    file "${APP_EXTRACT}/server/nas-webterm-aarch64" 2>/dev/null | grep -q 'aarch64' ||
        fail "server/nas-webterm-aarch64 不是 aarch64 架构"
fi

SIZE="$(du -h "${OUT_FILE}" | awk '{print $1}')"
SHA="$(sha256sum "${OUT_FILE}" | awk '{print $1}')"
ENTRIES="$(wc -l < "${LIST_FILE}" | tr -d '[:space:]')"

printf '%s\n' "${SHA}  ${APP_NAME}-${APP_VER}.fpk" > "${OUT_FILE}.sha256"

echo "文件：${OUT_FILE}（${SIZE}）"
echo "sha256：${SHA}"
echo "app.tgz 校验：${APP_MD5} ✔（${ENTRIES} 个条目，含 x86_64 + aarch64）"

printf '\n\033[1;32m✓ 构建完成：%s\033[0m\n' "${OUT_FILE}"
printf '安装方式：飞牛应用中心 → 我的应用 → 手动安装 → 选择该 .fpk 文件\n'
