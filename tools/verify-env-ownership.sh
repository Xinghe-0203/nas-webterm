#!/usr/bin/env bash
# cmd/main 的环境变量归属检查。
#
# fnOS 在某些批量启停场景下会把 A 应用的 TRIM_APPDEST/TRIM_PKGVAR
# 传给 B 应用的脚本。日志里出现过「微信时光机」的 stop 消息写进了
# nas-webterm-ai 的 info.log——两边都用 ${TRIM_PKGVAR:-...}，
# 变量一串，日志、数据、pid 文件就都写到别人家里去了。
#
# 所以 cmd/main 里有 check_env_owned_by_app：路径不属于本应用就拒绝执行。
# 这个脚本验证它真的拦得住。
#
# 用法：bash tools/verify-env-ownership.sh

set -u

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
MAIN="${ROOT}/cmd/main"

checks=0
failed=0

ok() {
    checks=$((checks + 1))
    printf '\033[32m✓\033[0m %s\n' "$1"
}

no() {
    checks=$((checks + 1))
    failed=$((failed + 1))
    printf '\033[31m✗\033[0m %s  %s\n' "$1" "${2:-}"
}

# 说明：本仓库的 cmd/main 里 APP_NAME 是 nas-webterm，
# 打包时构建脚本会按变体改成 nas-webterm / nas-webterm-ai。

# 1) 指向本应用的路径 → 允许
out="$(TRIM_APPDEST=/var/apps/nas-webterm/target \
       TRIM_PKGVAR=/var/apps/nas-webterm/var \
       TRIM_PKGHOME=/var/apps/nas-webterm/home \
       bash "${MAIN}" status 2>&1)"
rc=$?
if [ "${rc}" -eq 3 ] || [ "${rc}" -eq 0 ]; then
    ok "指向本应用时正常执行（status 返回 ${rc}）"
else
    no "指向本应用时正常执行" "返回 ${rc}: ${out}"
fi

# 2) 指向本应用的变体（nas-webterm-ai）→ 允许
out="$(TRIM_APPDEST=/vol2/@appcenter/nas-webterm-ai \
       TRIM_PKGVAR=/vol2/@appdata/nas-webterm-ai \
       TRIM_PKGHOME=/vol2/@apphome/nas-webterm-ai \
       bash "${MAIN}" status 2>&1)"
rc=$?
if [ "${rc}" -eq 3 ] || [ "${rc}" -eq 0 ]; then
    ok "指向本应用的变体时正常执行（status 返回 ${rc}）"
else
    no "指向本应用的变体时正常执行" "返回 ${rc}: ${out}"
fi

# 3) 指向别的应用 → 必须拒绝，且不能写进别人的日志
before_wx="$(wc -c < /vol2/@appdata/wx-vault/info.log 2>/dev/null || echo 0)"
out="$(TRIM_APPDEST=/vol2/@appcenter/wx-vault \
       TRIM_PKGVAR=/vol2/@appdata/wx-vault \
       TRIM_PKGHOME=/vol2/@apphome/wx-vault \
       bash "${MAIN}" status 2>&1)"
rc=$?
after_wx="$(wc -c < /vol2/@appdata/wx-vault/info.log 2>/dev/null || echo 0)"
if [ "${rc}" -ne 0 ] && [ "${rc}" -ne 3 ]; then
    ok "指向别的应用时拒绝执行（返回 ${rc}）"
else
    no "指向别的应用时拒绝执行" "返回 ${rc}，本该拒绝"
fi
if [ "${after_wx}" -eq "${before_wx}" ]; then
    ok "没有往别的应用的日志里写东西"
else
    no "没有往别的应用的日志里写东西" "wx-vault 的日志变长了 ${before_wx} → ${after_wx}"
fi

# 4) 只有 PKGVAR 串了 → 也要拒绝
out="$(TRIM_APPDEST=/vol2/@appcenter/nas-webterm-ai \
       TRIM_PKGVAR=/vol2/@appdata/wx-vault \
       TRIM_PKGHOME=/vol2/@apphome/nas-webterm-ai \
       bash "${MAIN}" status 2>&1)"
rc=$?
if [ "${rc}" -ne 0 ] && [ "${rc}" -ne 3 ]; then
    ok "只有 PKGVAR 串了时也拒绝执行（返回 ${rc}）"
else
    no "只有 PKGVAR 串了时也拒绝执行" "返回 ${rc}，本该拒绝"
fi

printf '\n结果：%d/%d 通过\n' "$((checks - failed))" "${checks}"
[ "${failed}" -eq 0 ] || exit 1
