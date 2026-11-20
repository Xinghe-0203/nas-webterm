#!/bin/bash
# Web 终端构建脚本（普通版 / AI 版）
#
# 产出两个**互相独立**的目录，各自是一份完整、可单独构建与安装的工程：
#
#   dist/plain/   普通版：纯终端，源码里没有任何 AI 代码
#   dist/ai/      AI 版：终端 + AI 助手
#
# 两个目录各自再打包成 .fpk：
#   dist/nas-webterm-1.2.1.fpk        （appname = nas-webterm）
#   dist/nas-webterm-ai-1.2.1.fpk    （appname = nas-webterm-ai）
#
# 变体差异只有两处，都在这一份源码里用「构建期开关」表达：
#   * Rust：Cargo feature `ai`。普通版用 --no-default-features 编译，
#           ai/ 与 agent 模块**根本不进二进制**。
#   * 前端：web/src/ai/bridge-entry.ts 由脚本生成，指向空实现或真实现；
#           同时普通版的 index.html 会删掉全部 AI 相关 DOM。
#
# 用法：
#   ./build.sh                   两个变体都构建
#   ./build.sh --variant plain   只构建普通版
#   ./build.sh --variant ai      只构建 AI 版
#   ./build.sh --with-browser    额外跑 headless 浏览器验证
#   ./build.sh --no-test         跳过冒烟测试
#   ./build.sh --arch x86_64     只出一个架构

set -euo pipefail

# 固定 umask：否则打出来的 .fpk / app.tgz 权限会随调用者的 umask 变（664 之类），
# 官方校验脚本会判成失败。
umask 022

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "${ROOT}"

RUN_SMOKE=1
RUN_BROWSER=0
ARCHS="both"
VARIANTS="both"

while [ $# -gt 0 ]; do
    case "$1" in
        --no-test) RUN_SMOKE=0 ;;
        --with-browser) RUN_BROWSER=1 ;;
        --arch)
            shift
            ARCHS="${1:-both}"
            ;;
        --variant)
            shift
            VARIANTS="${1:-both}"
            ;;
        -h | --help)
            sed -n '2,22p' "$0"
            exit 0
            ;;
        *)
            echo "未知参数: $1" >&2
            exit 1
            ;;
    esac
    shift
done

APP_VER="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' manifest | head -n1 | tr -d '[:space:]')"
OUT_DIR="${ROOT}/dist"

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
RUSTC="$(command -v rustc || true)"
[ -n "${RUSTC}" ] || fail "未找到 rustc"

case "${VARIANTS}" in
    both) VARIANT_LIST=(plain ai) ;;
    plain | ai) VARIANT_LIST=("${VARIANTS}") ;;
    *) fail "未知变体：${VARIANTS}（可选 plain / ai / both）" ;;
esac

mkdir -p "${OUT_DIR}"

# ---------------------------------------------------------------------------
step "1/10 检查前端依赖"
if [ ! -d "${ROOT}/web/node_modules" ]; then
    echo "首次构建，安装前端依赖…"
    (cd "${ROOT}/web" && npm install --no-audit --no-fund --loglevel=error) ||
        fail "前端依赖安装失败"
fi

# 内置的 Nerd Font 子集：终端里跑 oh-my-posh / starship 这类带图标的提示符时，
# 普通等宽字体没有私有区码点，图标会被画成彩色方块。
# 字体文件已经入库；这里只做一次存在性检查，缺了就提示怎么补。
if [ ! -f "${ROOT}/web/src/fonts/nerd.woff2" ]; then
    fail "缺少内置 Nerd Font 子集：web/src/fonts/nerd.woff2
生成方法：
  1. 下载 Nerd Font（https://github.com/ryanoasis/nerd-fonts/releases）
  2. pip install fonttools brotli
  3. python3 tools/subset-font.py <源字体.woff2> web/src/fonts/nerd.woff2"
fi

# ---------------------------------------------------------------------------
step "2/10 编译 Rust 后端（两个变体）"

# 每个变体、每个架构各编一次，产物放到 dist/.bins/<variant>/
compile_all_variants() {
    local variant arch
    case "${ARCHS}" in
        x86_64) archs=(x86_64) ;;
        aarch64) archs=(aarch64) ;;
        both | all) archs=(x86_64 aarch64) ;;
        *) fail "未知架构：${ARCHS}" ;;
    esac
    for variant in "${VARIANT_LIST[@]}"; do
        for arch in "${archs[@]}"; do
            build_variant_arch "${variant}" "${arch}"
        done
    done
}


# target 标准库是否就绪。
# 不直接依赖 rustup 的记账：有些环境的 rustup 元数据是坏的（半途安装失败），
# 但 sysroot 里其实已经有这个目标的标准库，直接看目录更可靠。
target_ready() {
    local libdir
    libdir="$("${RUSTC}" --print target-libdir --target "$1" 2>/dev/null)" || return 1
    [ -n "${libdir}" ] && [ -d "${libdir}" ]
}

ensure_target() {
    local target="$1"
    target_ready "${target}" && return 0
    if command -v rustup >/dev/null 2>&1; then
        rustup target add "${target}" >/dev/null 2>&1 || true
    fi
    target_ready "${target}" ||
        fail "缺少 Rust 目标 ${target} 的标准库（rustup target add ${target}）"
}

# build_arch <target> <cargo 参数...>
build_arch() {
    local target="$1"
    shift
    local -a cargo_args=("$@")
    echo "--- 编译 ${target} ${cargo_args[*]} ---"
    ensure_target "${target}"
    if [ "${target}" = "x86_64-unknown-linux-gnu" ]; then
        (cd "${ROOT}/rust" && "${CARGO}" build --release --target "${target}" "${cargo_args[@]}" >/dev/null) ||
            fail "编译 ${target} 失败"
    else
        command -v "aarch64-linux-gnu-gcc" >/dev/null 2>&1 ||
            fail "缺少交叉编译器 aarch64-linux-gnu-gcc，请安装 gcc-aarch64-linux-gnu"
        local cc_var
        cc_var="$(echo "${target}" | tr 'a-z-' 'A-Z_')"
        (cd "${ROOT}/rust" && env "CARGO_TARGET_${cc_var}_LINKER=aarch64-linux-gnu-gcc" \
            "CARGO_TARGET_${cc_var}_CC=aarch64-linux-gnu-gcc" \
            "${CARGO}" build --release --target "${target}" "${cargo_args[@]}" >/dev/null) ||
            fail "编译 ${target} 失败"
    fi
}

# 编译某个变体的某个架构，并复制到目标目录
# build_variant_arch <变体> <架构>
build_variant_arch() {
    local variant="$1" arch="$2"
    local target
    case "${arch}" in
        x86_64) target="x86_64-unknown-linux-gnu" ;;
        aarch64) target="aarch64-unknown-linux-gnu" ;;
    esac
    if [ "${variant}" = "plain" ]; then
        # 普通版：不带 ai feature，AI 模块根本不进二进制
        build_arch "${target}" --no-default-features
    else
        build_arch "${target}"
    fi
    local bin="${ROOT}/rust/target/${target}/release/nas-webterm"
    [ -x "${bin}" ] || fail "未找到编译产物 ${bin}"
    local dest="${ROOT}/dist/.bins/${variant}"
    mkdir -p "${dest}"
    cp "${bin}" "${dest}/nas-webterm-${arch}"
    chmod 755 "${dest}/nas-webterm-${arch}"
    echo "  → ${dest}/nas-webterm-${arch}  $(du -h "${dest}/nas-webterm-${arch}" | awk '{print $1}')"
}

# ---------------------------------------------------------------------------
step "3/10 编译两个变体的后端二进制"
compile_all_variants

# ---------------------------------------------------------------------------
step "4/10 构建前端（两个变体）"

# build_web <变体> <输出目录>
# 构建完立刻收进变体目录：两个变体共用 app/ui 这一个中间目录，
# 不马上收走的话第二个变体会覆盖第一个的产物。
build_web() {
    local variant="$1" dest="$2"
    echo "--- 前端：${variant} ---"
    (cd "${ROOT}/web" && node scripts/variant-bridge.mjs "${variant}") ||
        fail "生成 ${variant} 变体入口失败"
    rm -rf "${ROOT}/app/ui/assets"
    (cd "${ROOT}/web" && npx vite build >/dev/null) || fail "前端构建失败"
    if [ "${variant}" = "plain" ]; then
        (cd "${ROOT}/web" && node scripts/postbuild.mjs --plain) || fail "普通版后处理失败"
    else
        (cd "${ROOT}/web" && node scripts/postbuild.mjs) || fail "后处理失败"
    fi
    [ -f "${ROOT}/app/ui/index.html" ] || fail "前端产物缺失"
    [ -d "${ROOT}/app/ui/assets" ] || fail "前端产物缺失 assets/"
    rm -rf "${dest}"
    mkdir -p "${dest}"
    cp -a "${ROOT}/app/ui" "${dest}/ui"
    echo "  → ${dest}/ui  $(du -sh "${dest}/ui" | awk '{print $1}')"
}

# ---------------------------------------------------------------------------
step "5/10 组装两个独立目录"

# 先把两个变体的前端各自构建好并收进 dist/.ui/<variant>/
for VARIANT in "${VARIANT_LIST[@]}"; do
    build_web "${VARIANT}" "${OUT_DIR}/.ui/${VARIANT}"
done

# stage_variant <变体> <目标目录>
stage_variant() {
    local variant="$1" dest="$2"
    echo "--- ${variant} → ${dest} ---"
    rm -rf "${dest}"
    mkdir -p "${dest}"

    # 1) 应用骨架
    cp -a "${ROOT}/manifest" "${ROOT}/ICON.PNG" "${ROOT}/ICON_256.PNG" "${ROOT}/LICENSE" "${dest}/"
    cp -a "${ROOT}/cmd" "${ROOT}/config" "${ROOT}/wizard" "${dest}/"

    # 2) 变体专属的 manifest
    "${NODE_BIN}" "${ROOT}/tools/make-manifest.mjs" "${variant}" "${APP_VER}" "${dest}/manifest" ||
        fail "生成 ${variant} 版 manifest 失败"
    local stage_app
    stage_app="$(sed -n 's/^appname[[:space:]]*=[[:space:]]*//p' "${dest}/manifest" | head -n1 | tr -d '[:space:]')"
    local stage_display
    stage_display="$(sed -n 's/^display_name[[:space:]]*=[[:space:]]*//p' "${dest}/manifest" | head -n1 | sed 's/[[:space:]]*$//')"

    # 3) cmd/main：应用名 / 显示名 / 版本号 / 普通版打开 --no-ai
    sed -i "s|^APP_NAME=\"nas-webterm\"|APP_NAME=\"${stage_app}\"|" "${dest}/cmd/main"
    # 版本号从 manifest 同步过来，避免 cmd/main 里的兜底值忘改（升级日志会显示旧版本）
    sed -i "s|^APP_VERSION=\"[^\"]*\"|APP_VERSION=\"${APP_VER}\"|" "${dest}/cmd/main"
    sed -i "s|--display-name \"Web 终端\"|--display-name \"${stage_display}\"|" "${dest}/cmd/main"
    if [ "${variant}" = "plain" ]; then
        sed -i 's|^AI_DISABLED="${AI_DISABLED:-0}"|AI_DISABLED="${AI_DISABLED:-1}"|' "${dest}/cmd/main"
    fi

    # 4) 前端产物（step 5 已经把每个变体构建到 dist/.ui/<variant>/ui）
    #    注意：目标目录不能预先存在，否则 cp -a 会拷成 app/ui/ui
    mkdir -p "${dest}/app"
    rm -rf "${dest}/app/ui"
    cp -a "${OUT_DIR}/.ui/${variant}/ui" "${dest}/app/ui"

    # 5) 后端二进制
    mkdir -p "${dest}/app/server"
    local arch
    case "${ARCHS}" in
        x86_64) archs=(x86_64) ;;
        aarch64) archs=(aarch64) ;;
        both | all) archs=(x86_64 aarch64) ;;
        *) fail "未知架构：${ARCHS}" ;;
    esac
    for arch in "${archs[@]}"; do
        cp "${ROOT}/dist/.bins/${variant}/nas-webterm-${arch}" "${dest}/app/server/"
        chmod 755 "${dest}/app/server/nas-webterm-${arch}"
    done

    # 6) 桌面入口：entry key / 前缀 / 标题
    sed -i "s|nas-webterm\.Application|${stage_app}.Application|g" "${dest}/app/ui/config"
    sed -i "s|/app/nas-webterm|/app/${stage_app}|g" "${dest}/app/ui/config"
    sed -i "s|\"title\": \"Web 终端\"|\"title\": \"${stage_display}\"|" "${dest}/app/ui/config"
    sed -i "s|<title>Web 终端</title>|<title>${stage_display}</title>|" "${dest}/app/ui/index.html"

    # 7) 源码目录：让每个变体目录都能单独构建
    mkdir -p "${dest}/src"
    cp -a "${ROOT}/rust" "${ROOT}/web" "${ROOT}/tools" "${dest}/src/"
    cp -a "${ROOT}/build.sh" "${dest}/src/build.sh"
    cp -a "${ROOT}/manifest" "${dest}/src/manifest"
    rm -rf "${dest}/src/rust/target" "${dest}/src/web/node_modules"
    if [ "${variant}" = "plain" ]; then
        rm -rf "${dest}/src/rust/src/ai" "${dest}/src/web/src/ai"
        python3 "${ROOT}/tools/strip-ai-source.py" "${dest}/src" ||
            fail "普通版源码剥离失败"
    fi

    # 8) 交付目录里不留可下载的工具（build.sh 会自己下载 fnpack）
    rm -f "${dest}/src/tools/fnpack"

    # 9) 权限归一化
    find "${dest}/cmd" "${dest}/config" "${dest}/wizard" -type d -exec chmod 755 {} +
    find "${dest}/cmd" "${dest}/config" "${dest}/wizard" -type f -exec chmod 644 {} +
    chmod 755 "${dest}"/cmd/*
    chmod 644 "${dest}/manifest" "${dest}"/ICON*.PNG "${dest}/LICENSE" 2>/dev/null || true
    find "${dest}/app" -type f -exec chmod 644 {} +
    chmod 755 "${dest}"/app/server/* 2>/dev/null || true
}

# 组装两个变体的独立目录
for VARIANT in "${VARIANT_LIST[@]}"; do
    stage_variant "${VARIANT}" "${OUT_DIR}/${VARIANT}"
done

# ---------------------------------------------------------------------------
step "6/10 验证变体源码可独立构建"

# 普通版目录必须**自洽可编译**：源码里没有 AI 代码，也不依赖主源码树。
# 这里真的编一次，防止剥离脚本漏改导致交付的目录编不过。
verify_variant_source_build() {
    local variant="$1"
    local src="${OUT_DIR}/${variant}/src"
    [ -d "${src}" ] || fail "${variant} 目录里没有 src/"
    echo "--- 验证 ${variant} 源码可独立构建 ---"
    if [ "${variant}" = "plain" ]; then
        # 普通版：不能出现任何 AI 源码
        for pat in 'ai.rs' 'agent.rs' 'history.rs' 'events.rs' 'protocol.rs' 'panel.ts' 'bridge-ai.ts' 'inline.ts' 'detect.ts' 'history.ts'; do
            if find "${src}" -name "${pat}" 2>/dev/null | grep -q .; then
                fail "普通版源码里还有 AI 文件：${pat}"
            fi
        done
        # 普通版源码里不能有任何 AI feature 门控或运行期 cfg! 判断。
        if grep -rq 'cfg(feature = "ai")\|cfg!(feature = "ai")' "${src}/rust" 2>/dev/null; then
            fail "普通版源码里还有 AI feature 门控"
        fi
        echo "  普通版：无 AI 源码 ✔"
    fi
    # 真的编一次（只编本机架构，够验证源码自洽）
    local arch target
    case "$(uname -m)" in
        x86_64) arch=x86_64; target=x86_64-unknown-linux-gnu ;;
        aarch64 | arm64) arch=aarch64; target=aarch64-unknown-linux-gnu ;;
    esac
    ( cd "${src}/rust" && "${CARGO}" build --release --target "${target}" >/dev/null 2>&1 ) ||
        fail "${variant} 版源码独立编译失败"
    echo "  ${variant} 源码独立编译通过 ✔"
    rm -rf "${src}/rust/target"
}

for VARIANT in "${VARIANT_LIST[@]}"; do
    verify_variant_source_build "${VARIANT}"
done

# ---------------------------------------------------------------------------
step "7/10 冒烟测试"
if [ "${RUN_SMOKE}" -eq 1 ]; then
    bash "${ROOT}/tools/smoke-test.sh" plain || fail "冒烟测试失败"
else
    echo "已通过 --no-test 跳过"
fi

# ---------------------------------------------------------------------------
step "8/10 浏览器验证"
if [ "${RUN_BROWSER}" -eq 1 ]; then
    CHROME_BIN="${CHROME_BIN:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}"
    if [ -z "${CHROME_BIN}" ]; then
        echo "未找到 chromium，跳过浏览器验证" >&2
    else
        DEV_PORT="${DEV_PORT:-18098}"
        # 用**普通版目录**里的前端 + 普通版二进制：两者必须配套，
        # 拿 AI 版的页面配普通版后端来测，测的就不是要交付的东西了。
        "${ROOT}/dist/.bins/plain/nas-webterm-$(uname -m | sed 's/arm64/aarch64/')" \
            --host 127.0.0.1 --port "${DEV_PORT}" \
            --ui-dir "${ROOT}/dist/plain/app/ui" --gateway-prefix "/app/nas-webterm" \
            --app-name "nas-webterm" --version "${APP_VER}" \
            --cwd "${HOME}" --require-admin false \
            >"${OUT_DIR}/.browser-test.log" 2>&1 &
        DEV_PID="$!"
        trap 'kill "${DEV_PID:-}" 2>/dev/null || true' EXIT
        sleep 3
        CHROME_BIN="${CHROME_BIN}" "${NODE_BIN}" "${ROOT}/tools/verify-browser.mjs" \
            --url "http://127.0.0.1:${DEV_PORT}/app/nas-webterm/" \
            --title "Web" --expect ".xterm" \
            --api "./api/healthz" --ws "/app/nas-webterm/api/ws" \
            --type "echo build-check-ok" \
            --screenshot "${ROOT}/docs/screenshots/build-verify.png" || fail "浏览器验证失败"
        CHROME_BIN="${CHROME_BIN}" "${NODE_BIN}" "${ROOT}/tools/verify-vt.mjs" \
            --url "http://127.0.0.1:${DEV_PORT}/app/nas-webterm/" \
            --screenshot "${ROOT}/docs/screenshots" --name vt-regression ||
            fail "VT 兼容性回归测试失败"
        CHROME_BIN="${CHROME_BIN}" "${NODE_BIN}" "${ROOT}/tools/verify-shortcuts.mjs" \
            --url "http://127.0.0.1:${DEV_PORT}/app/nas-webterm/" ||
            fail "快捷键验证失败"
        # 内置 Nerd Font：终端里的 powerline 图标不能显示成方块
        CHROME_BIN="${CHROME_BIN}" "${NODE_BIN}" "${ROOT}/tools/verify-nerd-font.mjs" \
            --url "http://127.0.0.1:${DEV_PORT}/app/nas-webterm/" ||
            fail "Nerd Font 验证失败"

        # AI 版的设置窗：字段回填与保存（普通版没有 AI，跳过）
        if [ -d "${ROOT}/dist/ai/app/ui" ]; then
            AI_TEST_PORT="${AI_TEST_PORT:-18096}"
            AI_TEST_DIR="$(mktemp -d)"
            AI_MOCK_PORT="${AI_MOCK_PORT:-18097}"
            "${NODE_BIN}" "${ROOT}/tools/mock-ai.mjs" --port "${AI_MOCK_PORT}" >/dev/null 2>&1 &
            AI_MOCK_PID="$!"
            sleep 1
            "${ROOT}/dist/.bins/ai/nas-webterm-$(uname -m | sed 's/arm64/aarch64/')" \
                --host 127.0.0.1 --port "${AI_TEST_PORT}" \
                --ui-dir "${ROOT}/dist/ai/app/ui" --gateway-prefix "/app/nas-webterm-ai" \
                --app-name "nas-webterm-ai" --version "${APP_VER}" \
                --cwd "${HOME}" --require-admin false \
                --ai-config "${AI_TEST_DIR}/ai.json" >/dev/null 2>&1 &
            AI_TEST_PID="$!"
            sleep 2
            CHROME_BIN="${CHROME_BIN}" "${NODE_BIN}" "${ROOT}/tools/verify-ai-settings.mjs" \
                --url "http://127.0.0.1:${AI_TEST_PORT}/app/nas-webterm-ai/" ||
                fail "AI 设置保存验证失败"

            # AI 面板：文字只出现在面板里、命令卡片可折叠
            curl -s -X POST "http://127.0.0.1:${AI_TEST_PORT}/app/nas-webterm-ai/api/ai/config" \
                -H 'Content-Type: application/json' \
                -d "{\"enabled\":true,\"baseUrl\":\"http://127.0.0.1:${AI_TEST_PORT}/v1\",\"apiKey\":\"sk-build-test\",\"model\":\"mock\",\"autoExecSafe\":true}" \
                >/dev/null || true
            # mock 模型要指向上面起的那个 mock 服务
            curl -s -X POST "http://127.0.0.1:${AI_TEST_PORT}/app/nas-webterm-ai/api/ai/config" \
                -H 'Content-Type: application/json' \
                -d "{\"baseUrl\":\"http://127.0.0.1:${AI_MOCK_PORT}/v1\"}" >/dev/null || true
            CHROME_BIN="${CHROME_BIN}" "${NODE_BIN}" "${ROOT}/tools/verify-ai-panel.mjs" \
                --url "http://127.0.0.1:${AI_TEST_PORT}/app/nas-webterm-ai/" \
                --screenshot "${ROOT}/docs/screenshots/ai-panel.png" ||
                fail "AI 面板验证失败"

            kill "${AI_TEST_PID}" "${AI_MOCK_PID}" 2>/dev/null || true
            rm -rf "${AI_TEST_DIR}"
        fi

        kill "${DEV_PID}" 2>/dev/null || true
        rm -f "${OUT_DIR}/.browser-test.log"
    fi
else
    echo "已跳过（加 --with-browser 可开启）"
fi

# ---------------------------------------------------------------------------
step "9/10 打包 .fpk"
FNPACK="$(find_fnpack)"
echo "fnpack: ${FNPACK}"

PRODUCED=()
for VARIANT in "${VARIANT_LIST[@]}"; do
    DEST="${OUT_DIR}/${VARIANT}"
    STAGE_APP="$(sed -n 's/^appname[[:space:]]*=[[:space:]]*//p' "${DEST}/manifest" | head -n1 | tr -d '[:space:]')"
    ( cd "${DEST}" && "${FNPACK}" build >/dev/null ) || fail "${VARIANT} 版打包失败"
    [ -f "${DEST}/${STAGE_APP}.fpk" ] || fail "fnpack 未生成 ${STAGE_APP}.fpk"
    OUT_FILE="${OUT_DIR}/${STAGE_APP}-${APP_VER}.fpk"
    chmod 644 "${DEST}/${STAGE_APP}.fpk"
    mv -f "${DEST}/${STAGE_APP}.fpk" "${OUT_FILE}"
    rm -f "${DEST}/${STAGE_APP}.fpk"
    PRODUCED+=("${OUT_FILE}")
    echo "  → ${OUT_FILE}"
done

# ---------------------------------------------------------------------------
step "10/10 校验产物"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"; kill "${DEV_PID:-}" 2>/dev/null || true' EXIT

for OUT_FILE in "${PRODUCED[@]}"; do
    NAME="$(basename "${OUT_FILE}")"
    WORK="${TMP_DIR}/$(basename "${OUT_FILE}" .fpk)"
    mkdir -p "${WORK}"
    tar -xzf "${OUT_FILE}" -C "${WORK}" app.tgz manifest cmd || fail "解包 ${NAME} 失败"

    APP_MD5="$(md5sum "${WORK}/app.tgz" | awk '{print $1}')"
    MANIFEST_MD5="$(sed -n 's/^checksum[[:space:]]*=[[:space:]]*//p' "${WORK}/manifest" | head -n1 | tr -d '[:space:]')"
    [ -n "${MANIFEST_MD5}" ] || fail "${NAME} 的 manifest 缺少 checksum"
    [ "${APP_MD5}" = "${MANIFEST_MD5}" ] || fail "${NAME} checksum 不匹配"

    LIST_FILE="${WORK}/entries.txt"
    tar -tzf "${WORK}/app.tgz" > "${LIST_FILE}" || fail "读取 ${NAME} 的 app.tgz 失败"
    grep -q '\.DS_Store' "${LIST_FILE}" && fail "${NAME} 中残留 .DS_Store"

    for arch in x86_64 aarch64; do
        grep -qx "server/nas-webterm-${arch}" "${LIST_FILE}" || fail "${NAME} 缺少 ${arch} 二进制"
    done
    grep -qx 'ui/index.html' "${LIST_FILE}" || fail "${NAME} 缺少 ui/index.html"

    # 变体自检：真的把这个包装起来跑一遍，看行为对不对
    STAGED_MAIN="${WORK}/cmd/main"
    [ -f "${STAGED_MAIN}" ] || fail "${NAME} 解包后找不到 cmd/main"
    RUN_DIR="${WORK}/run"
    mkdir -p "${RUN_DIR}/target" "${RUN_DIR}/var" "${RUN_DIR}/home"
    cp -a "${WORK}/cmd" "${RUN_DIR}/cmd"
    cp -a "${WORK}/app.tgz" "${RUN_DIR}/"
    tar -xzf "${RUN_DIR}/app.tgz" -C "${RUN_DIR}/target"
    PREFIX_N="$(sed -n 's/^appname[[:space:]]*=[[:space:]]*//p' "${WORK}/manifest" | head -n1 | tr -d '[:space:]')"
    (
        cd "${RUN_DIR}"
        TRIM_APPDEST="${RUN_DIR}/target" TRIM_PKGVAR="${RUN_DIR}/var" \
        TRIM_PKGHOME="${RUN_DIR}/home" TRIM_APPVER="${APP_VER}" \
        TRIM_USERNAME="" TRIM_GID="" \
        "${RUN_DIR}/cmd/main" start >/dev/null 2>&1
    )
    sleep 2
    AI_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
        --unix-socket "${RUN_DIR}/target/app.sock" \
        -H 'X-Trim-Username: admin' -H 'X-Trim-Isadmin: true' \
        "http://localhost/app/${PREFIX_N}/api/ai/config" 2>/dev/null)"
    (
        cd "${RUN_DIR}"
        TRIM_APPDEST="${RUN_DIR}/target" TRIM_PKGVAR="${RUN_DIR}/var" \
        TRIM_PKGHOME="${RUN_DIR}/home" TRIM_APPVER="${APP_VER}" \
        TRIM_USERNAME="" TRIM_GID="" \
        "${RUN_DIR}/cmd/main" stop >/dev/null 2>&1
    )
    if printf '%s' "${NAME}" | grep -q -- '-ai-'; then
        [ "${AI_CODE}" = "200" ] || fail "${NAME} 是 AI 版，但 /api/ai/config 返回 ${AI_CODE}（应为 200）"
        echo "  AI 版：/api/ai/config → ${AI_CODE} ✔"
    else
        [ "${AI_CODE}" = "404" ] || fail "${NAME} 是普通版，但 /api/ai/config 返回 ${AI_CODE}（应为 404）"
        echo "  普通版：/api/ai/config → ${AI_CODE} ✔"
    fi

    # 普通版：产物里不能有任何 AI 痕迹
    if ! printf '%s' "${NAME}" | grep -q -- '-ai-'; then
        mkdir -p "${WORK}/uix"
        tar -xzf "${WORK}/app.tgz" -C "${WORK}/uix" ui 2>/dev/null || true
        for pat in 'execute_command' 'reasoning_effort' 'api/ai' 'ai-dock' 'ai-input' 'ai-settings-dialog'; do
            if grep -rqF -- "${pat}" "${WORK}/uix/ui" 2>/dev/null; then
                fail "${NAME} 的前端产物里仍有 AI 痕迹：${pat}"
            fi
        done
        echo "  普通版：前端产物无 AI 痕迹 ✔"
    fi

    SHA="$(sha256sum "${OUT_FILE}" | awk '{print $1}')"
    SIZE="$(du -h "${OUT_FILE}" | awk '{print $1}')"
    printf '%s\n' "${SHA}  ${NAME}" > "${OUT_FILE}.sha256"
    echo "${NAME}（${SIZE}） sha256=${SHA}"
done

printf '\n\033[1;32m✓ 构建完成\033[0m\n'
printf '独立目录：\n'
for VARIANT in "${VARIANT_LIST[@]}"; do printf '  %s\n' "${OUT_DIR}/${VARIANT}"; done
printf '安装包：\n'
for f in "${PRODUCED[@]}"; do printf '  %s\n' "${f}"; done
printf '安装方式：飞牛应用中心 → 我的应用 → 手动安装 → 选择对应的 .fpk 文件\n'
printf '两个版本 appname 不同，可以同时安装在一台机器上。\n'
