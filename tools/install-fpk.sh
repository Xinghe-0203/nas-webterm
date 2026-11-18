#!/bin/bash
# 按飞牛应用中心的布局安装/升级一个 .fpk（应用中心没有可调用的本地安装接口时的兜底）。
#
# 做的事情与安装器一致：
#   1. 解包 .fpk 到 /var/apps/<appname>/
#   2. 解 app.tgz 到 @appcenter/<appname>
#   3. 建 etc/home/tmp/var/meta 符号链接与目录
#   4. 依次跑 install_init → install_callback，或升级时的 upgrade_init → upgrade_callback
#
# 用法：sudo bash tools/install-fpk.sh <path/to/app.fpk> [--upgrade]
set -uo pipefail

FPK="${1:-}"
MODE="${2:-}"
[ -f "${FPK}" ] || { echo "用法: $0 <app.fpk> [--upgrade]" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
tar -xzf "${FPK}" -C "${WORK}" || { echo "解包失败" >&2; exit 1; }

APP="$(sed -n 's/^appname[[:space:]]*=[[:space:]]*//p' "${WORK}/manifest" | head -1 | tr -d '[:space:]')"
VER="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' "${WORK}/manifest" | head -1 | tr -d '[:space:]')"
[ -n "${APP}" ] || { echo "manifest 缺少 appname" >&2; exit 1; }
echo "安装 ${APP} ${VER} → /var/apps/${APP}"

ROOT=/var/apps/${APP}
DATA=/vol2/@appdata/${APP}
CENTER=/vol2/@appcenter/${APP}
CONF=/vol2/@appconf/${APP}
HOME_=/vol2/@apphome/${APP}
TMPD=/vol2/@apptemp/${APP}
META=/vol2/@appmeta/${APP}

# 升级前先停
if [ -x "${ROOT}/cmd/main" ]; then
    TRIM_APPDEST="${CENTER}" TRIM_PKGVAR="${DATA}" TRIM_PKGHOME="${HOME_}" \
        "${ROOT}/cmd/main" stop >/dev/null 2>&1 || true
fi

mkdir -p "${ROOT}" "${DATA}" "${CENTER}" "${CONF}" "${HOME_}" "${TMPD}" "${META}"

# 1) .fpk 顶层 → /var/apps/<app>（除了 app.tgz）
cp -a "${WORK}/manifest" "${WORK}"/ICON*.PNG "${ROOT}/" 2>/dev/null
cp -a "${WORK}/cmd" "${WORK}/config" "${WORK}/wizard" "${ROOT}/" 2>/dev/null
[ -f "${WORK}/LICENSE" ] && cp -a "${WORK}/LICENSE" "${ROOT}/"

# 2) app.tgz → @appcenter/<app>
rm -rf "${CENTER:?}"/* 2>/dev/null
tar -xzf "${WORK}/app.tgz" -C "${CENTER}"

# 3) 符号链接
ln -sfn "${CENTER}" "${ROOT}/target"
ln -sfn "${CONF}" "${ROOT}/etc"
ln -sfn "${HOME_}" "${ROOT}/home"
ln -sfn "${TMPD}" "${ROOT}/tmp"
ln -sfn "${DATA}" "${ROOT}/var"
ln -sfn "${META}" "${ROOT}/meta"

chmod 755 "${ROOT}"/cmd/* 2>/dev/null
chmod 644 "${ROOT}/manifest" "${ROOT}"/ICON*.PNG 2>/dev/null

export TRIM_APPDEST="${CENTER}" TRIM_PKGVAR="${DATA}" TRIM_PKGHOME="${HOME_}" \
       TRIM_PKGETC="${CONF}" TRIM_PKGTMP="${TMPD}" TRIM_APPNAME="${APP}" \
       TRIM_APPVER="${VER}" TRIM_USERNAME="" TRIM_GID=""

# 4) 生命周期回调
if [ "${MODE}" = "--upgrade" ]; then
    # 升级向导里的默认选项：清掉旧版遗留的启动命令、会话永不回收
    export wizard_clear_startup=true wizard_keep_sessions=true wizard_delete_data=false
    [ -x "${ROOT}/cmd/upgrade_init" ] && "${ROOT}/cmd/upgrade_init" >/dev/null 2>&1
    [ -x "${ROOT}/cmd/install_callback" ] && "${ROOT}/cmd/install_callback" >/dev/null 2>&1
    [ -x "${ROOT}/cmd/upgrade_callback" ] && "${ROOT}/cmd/upgrade_callback" >/dev/null 2>&1
else
    export wizard_default_shell=/bin/bash wizard_default_cwd=/root wizard_startup_command="" \
           wizard_idle_minutes=0 wizard_max_sessions=32 wizard_strict_admin=true
    [ -x "${ROOT}/cmd/install_init" ] && "${ROOT}/cmd/install_init" >/dev/null 2>&1
    [ -x "${ROOT}/cmd/install_callback" ] && "${ROOT}/cmd/install_callback" >/dev/null 2>&1
fi

"${ROOT}/cmd/main" start >/dev/null 2>&1
sleep 2
if "${ROOT}/cmd/main" status >/dev/null 2>&1; then
    echo "✓ ${APP} 已运行（pid=$(cat "${DATA}/webterm.pid" 2>/dev/null)）"
else
    echo "✗ ${APP} 启动失败，看 ${DATA}/info.log" >&2
    tail -5 "${DATA}/info.log" 2>/dev/null >&2
    exit 1
fi
