#!/bin/bash
# 生成应用图标（macOS Terminal 风格：黑色圆角方块 + 白色 >_ 提示符）
#
# 依赖：chromium（或 google-chrome）+ ffmpeg
# 产物：ICON.PNG(64) / ICON_256.PNG(256) / app/ui/images/icon_{64,256}.png
# 四处图标必须完全一致，否则会出现「应用中心是新图标、桌面还是旧图标」。

set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${ROOT}"

CHROME_BIN="${CHROME_BIN:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}"
[ -n "${CHROME_BIN}" ] || { echo "未找到 chromium，无法生成图标" >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "未找到 ffmpeg，无法缩放图标" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "使用浏览器: ${CHROME_BIN}"
"${CHROME_BIN}" \
    --headless=new \
    --hide-scrollbars \
    --no-sandbox \
    --disable-gpu \
    --default-background-color=00000000 \
    --window-size=256,256 \
    --screenshot="${TMP_DIR}/icon_256.png" \
    "file://${ROOT}/tools/icon.html" >/dev/null 2>&1

[ -f "${TMP_DIR}/icon_256.png" ] || { echo "图标截图失败" >&2; exit 1; }

ffmpeg -y -loglevel error -i "${TMP_DIR}/icon_256.png" -vf scale=256:256:flags=lanczos "${TMP_DIR}/out256.png"
ffmpeg -y -loglevel error -i "${TMP_DIR}/icon_256.png" -vf scale=64:64:flags=lanczos "${TMP_DIR}/out64.png"

cp "${TMP_DIR}/out256.png" "${ROOT}/ICON_256.PNG"
cp "${TMP_DIR}/out64.png" "${ROOT}/ICON.PNG"
mkdir -p "${ROOT}/app/ui/images"
cp "${TMP_DIR}/out64.png" "${ROOT}/app/ui/images/icon_64.png"
cp "${TMP_DIR}/out256.png" "${ROOT}/app/ui/images/icon_256.png"

echo "图标已生成："
ls -l "${ROOT}/ICON.PNG" "${ROOT}/ICON_256.PNG" \
    "${ROOT}/app/ui/images/icon_64.png" "${ROOT}/app/ui/images/icon_256.png"
