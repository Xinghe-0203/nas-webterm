#!/bin/bash
# 本地开发预览：直接监听 TCP 端口（无需安装 fpk）。
#
#   ./tools/dev.sh            http://127.0.0.1:18086/app/nas-webterm/
#
# 端口可用 DEV_PORT 覆盖；网关前缀固定为 /app/nas-webterm，与线上保持一致，
# 这样前端拿到的资源路径、WS 地址都和真实环境相同。

set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${ROOT}"

PORT="${DEV_PORT:-18086}"
HOST="${DEV_HOST:-127.0.0.1}"
BIN="${ROOT}/rust/target/release/nas-webterm"

if [ ! -x "${BIN}" ]; then
    echo "未找到后端二进制，请先执行：cargo build --release（目录 ${ROOT}/rust）" >&2
    exit 1
fi

if [ ! -f "${ROOT}/app/ui/index.html" ]; then
    echo "未找到前端产物，请先在 ${ROOT}/web 执行：npm install && npx vite build && node scripts/postbuild.mjs" >&2
    exit 1
fi

echo "开发服务启动：http://${HOST}:${PORT}/app/nas-webterm/"
exec "${BIN}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --ui-dir "${ROOT}/app/ui" \
    --gateway-prefix "/app/nas-webterm" \
    --app-name "nas-webterm" \
    --display-name "Web 终端" \
    --version "dev" \
    --shell "${DEV_SHELL:-/bin/bash}" \
    --cwd "${DEV_CWD:-${HOME:-/root}}" \
    --startup-command "${DEV_STARTUP_COMMAND:-}" \
    --require-admin false
