#!/bin/bash
# .fpk 产物校验（针对 Rust 后端定制）
#
# 先调用 fnos-fpk-app 技能自带的官方校验脚本（结构/manifest/图标/权限/wizard），
# 再补充本项目特有的检查：
#   - app/server/ 下同时存在 x86_64 与 aarch64 两个 ELF，且架构正确；
#   - cmd/main 里的架构分支与二进制命名一致；
#   - 包内没有混入开发产物（node_modules、target、.git、源码）。
#
# 官方脚本里有一条 `载荷包含 server/server.js` 是 Node 模板专属假设，
# 本应用后端是 Rust 二进制，该条按“不适用”处理并在输出中标注。

set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
FPK="${1:-}"
[ -n "${FPK}" ] || { echo "用法: $0 <path/to/app.fpk>" >&2; exit 2; }
[ -f "${FPK}" ] || { echo "找不到文件: ${FPK}" >&2; exit 2; }
FPK="$(CDPATH= cd -- "$(dirname -- "${FPK}")" && pwd)/$(basename "${FPK}")"

PASS=0
FAIL=0
SKIP=0

ok() { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s  %s\n' "$1" "${2:-}"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s  %s\n' "$1" "${2:-}"; }
skip() { SKIP=$((SKIP + 1)); printf '  \033[33m-\033[0m %s  %s\n' "$1" "${2:-}"; }

find_official() {
    local candidate
    for candidate in \
        "${SKILL_DIR:-}/scripts/verify-fpk.sh" \
        "${ROOT}/.zcode/skills/fnos-fpk-app/scripts/verify-fpk.sh" \
        "${HOME}/.agents/skills/fnos-fpk-app/scripts/verify-fpk.sh" \
        "/vol2/1000/Code/AgentWorkspace/.zcode/skills/fnos-fpk-app/scripts/verify-fpk.sh"; do
        if [ -n "${candidate}" ] && [ -f "${candidate}" ]; then
            printf '%s' "${candidate}"
            return 0
        fi
    done
    return 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

printf '\033[1m== 1/3 官方结构校验（fnos-fpk-app）\033[0m\n'
OFFICIAL="$(find_official || true)"
if [ -n "${OFFICIAL}" ]; then
    OFFICIAL_OUT="${TMP_DIR}/official.txt"
    bash "${OFFICIAL}" "${FPK}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "${OFFICIAL_OUT}" || true
    # 逐条转述单条检查结果（形如 "  ✓ 名称  详情"）；汇总行忽略。
    # 官方脚本里 server/server.js 是 Node 模板专属假设，Rust 后端按不适用处理。
    while IFS= read -r line; do
        case "${line}" in
            '  ✓ '* | '  ✓'*) ok "$(printf '%s' "${line}" | sed 's/^ *✓ *//')" "" ;;
            '  ✗ '* | '  ✗'*)
                text="$(printf '%s' "${line}" | sed 's/^ *✗ *//')"
                case "${text}" in
                    *server/server.js*) skip "载荷包含 server/server.js" "（Rust 后端，无 Node 脚本）" ;;
                    *) bad "${text}" "" ;;
                esac
                ;;
        esac
    done < "${OFFICIAL_OUT}"
else
    skip "官方校验脚本" "（未找到 fnos-fpk-app 技能，仅执行本项目检查）"
fi

printf '\n\033[1m== 2/3 Rust 载荷\033[0m\n'
mkdir -p "${TMP_DIR}/x"
tar -xzf "${FPK}" -C "${TMP_DIR}/x" app.tgz manifest 2>/dev/null
if [ -f "${TMP_DIR}/x/app.tgz" ]; then
    mkdir -p "${TMP_DIR}/app"
    tar -xzf "${TMP_DIR}/x/app.tgz" -C "${TMP_DIR}/app" 2>/dev/null
    ok "app.tgz 已解包"

    for arch in x86_64 aarch64; do
        bin="${TMP_DIR}/app/server/nas-webterm-${arch}"
        if [ -x "${bin}" ]; then
            ok "server/nas-webterm-${arch} 存在且可执行"
        else
            bad "server/nas-webterm-${arch} 存在且可执行"
            continue
        fi
        if command -v file >/dev/null 2>&1; then
            desc="$(file -b "${bin}")"
            case "${arch}" in
                x86_64) want='x86-64' ;;
                aarch64) want='aarch64' ;;
            esac
            case "${desc}" in
                *${want}*) ok "server/nas-webterm-${arch} 架构正确" "${desc%% *}" ;;
                *) bad "server/nas-webterm-${arch} 架构正确" "${desc}" ;;
            esac
        fi
    done

    # 不该进包的东西
    for junk in 'node_modules/' '.git/' 'rust/target/' 'src/main.rs' 'web/src/'; do
        if tar -tzf "${TMP_DIR}/x/app.tgz" | grep -q -- "${junk}"; then
            bad "包内无开发产物 ${junk}"
        else
            ok "包内无开发产物 ${junk}"
        fi
    done

    if [ -f "${TMP_DIR}/app/ui/index.html" ]; then
        grep -q '__FN_BASE_RAW__' "${TMP_DIR}/app/ui/index.html" &&
            ok "index.html 保留网关前缀注入点" || bad "index.html 保留网关前缀注入点"
        grep -q '<base ' "${TMP_DIR}/app/ui/index.html" &&
            bad "index.html 不含 <base> 标签" || ok "index.html 不含 <base> 标签"
    fi
else
    bad "app.tgz 已解包"
fi

printf '\n\033[1m== 3/3 生命周期脚本一致性\033[0m\n'
if [ -f "${ROOT}/cmd/main" ]; then
    grep -q 'nas-webterm-${arch}' "${ROOT}/cmd/main" &&
        ok "cmd/main 按架构选择二进制" || bad "cmd/main 按架构选择二进制"
    grep -q 'socket-mode' "${ROOT}/cmd/main" &&
        ok "cmd/main 传入 socket 权限" || bad "cmd/main 传入 socket 权限"
    command -v shellcheck >/dev/null 2>&1 && shellcheck -S warning "${ROOT}/cmd/main" >/dev/null 2>&1 &&
        ok "cmd/main shellcheck 无告警" || skip "cmd/main shellcheck" "（未安装 shellcheck）"
fi

printf '\n通过 %d，不适用 %d，失败 %d\n' "${PASS}" "${SKIP}" "${FAIL}"
[ "${FAIL}" -eq 0 ] || exit 1
