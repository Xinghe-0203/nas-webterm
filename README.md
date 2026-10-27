# Web 终端（nas-webterm）

飞牛 fnOS 的浏览器式多标签 Web 终端。后端 **Rust**（tokio + axum + portable-pty），前端 **TypeScript + xterm.js**。
每个标签页是一个真实的后台 PTY 进程，默认以 **root** 身份运行，全屏 TUI 程序（vim、htop、top…）可直接使用。

- 应用名：`nas-webterm`
- 显示名：Web 终端
- 版本：1.0.0
- 产物：`dist/nas-webterm-1.0.0.fpk`（含 x86_64 + aarch64 双架构）

---

## 1. 功能

| 能力 | 说明 |
| --- | --- |
| 浏览器式多标签 | 新建 / 关闭 / 中键关闭 / 快捷键切换，每个标签是独立的 shell 会话 |
| root 权限 | 默认以 root 启动交互式 shell，可直接执行 `docker`、`systemctl` 等特权操作 |
| 真彩色 TUI | `TERM=xterm-256color`、`COLORTERM=truecolor`、备用屏幕、鼠标跟踪、括号粘贴全部原生支持 |
| WebGL 渲染 | xterm.js WebGL 渲染器，全屏重绘不掉帧；不支持时自动回落到 Canvas/DOM |
| 断线重连 | 关页面/断网后会话继续跑（默认永不超时回收），刷新/重连回放最近输出并接回原会话 |
| 全屏程序还原 | 全屏 TUI 程序（vim / htop / top…）在关掉页面、过很久再打开时，界面会正确重建而不是乱码或空白 |
| 资源回收 | 会话结束时子进程被 wait 回收，不留僵尸进程；前端关闭标签页会释放终端实例、观察器与输出缓冲 |
| 自适应尺寸 | 浏览器窗口变化实时调整 PTY 行列数，TUI 会跟着重排 |
| 中日韩字符 | Unicode 11 宽度计算，中文/emoji 对齐正确 |
| 自动执行命令（可选） | 默认关闭。想常开某个程序时，可在设置里填一条命令，新标签页会自动执行它 |
| 长期挂着 | 默认**永不按时间杀会话**，终端可以连开好几天；只有关掉标签页或程序自己退出才结束 |

### 快捷键

| 按键 | 作用 |
| --- | --- |
| `Alt+Shift+T` | 新建标签页 |
| `Alt+Shift+W` | 关闭当前标签页 |
| `Alt+Shift+←/→` 或 `↑/↓` | 上一个 / 下一个标签页 |
| `Alt+Shift+1..9` | 跳到第 N 个标签页 |
| `Ctrl/Cmd +` `=/-` / `0` | 放大 / 缩小 / 复位字号 |

终端内的常规快捷键（`Ctrl+C`、`Ctrl+D`、`Ctrl+R`、`Ctrl+L` 等）原样传给 shell，不会被页面拦截。

---

## 2. 安装

1. 打开飞牛 → **应用中心 → 我的应用 → 手动安装**，选择 `dist/nas-webterm-1.0.0.fpk`。
2. 安装向导里确认 shell、工作目录等参数（默认值即可）。**「启动后自动执行的命令」默认留空**，
   新标签页就是普通 shell；想常驻某个程序就在这一项填上它。
3. 安装完成后回到桌面，点击「Web 终端」图标。

> 桌面入口只对**管理员**显示（`allUsers=false`），这是刻意设计：应用提供 root shell。

---

## 3. 安全模型

理解这一点再用，很重要。

- **后端以 root 运行**，因为它要提供 root shell。没有这个前提就无法真正替代终端。
- **不监听任何 TCP 端口**：服务只监听 `${TRIM_APPDEST}/app.sock`，由飞牛统一网关（root 运行的 `trim_http_cgi`）转发。
- **socket 权限 0600 + root:root**：即使同机其它应用读到路径也连不上。
- **双重管理员校验**：桌面入口只对管理员显示；服务端再校验网关注入的 `X-Trim-Isadmin` 头，非管理员一律 403。
- **网关层认证**：`/app/*` 走飞牛登录态，未登录直接 401/跳登录页，应用本身不接触密码。
- **数据不出本机**：终端输入输出只走内存，不落盘、不上传；日志里不记录终端内容。
- 页面有 CSP（`default-src 'self'`、`frame-ancestors 'self'`），只允许同源资源。

---

## 4. 配置项

安装后在 **应用中心 → Web 终端 → 设置** 里修改，改动会持久化到 `${TRIM_PKGVAR}/settings.env` 并自动重启服务。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| 默认 Shell | `/bin/bash` | 新标签页启动的 shell，可填 `/usr/bin/zsh`、`/usr/bin/fish` |
| 默认工作目录 | `/root` | 目录不存在或不可进入时自动回退 |
| 启动后自动执行的命令 | 空 | 默认只开普通 shell。填了才会自动键入并回车；清空保存后立即失效 |
| 会话空闲回收（分钟） | `0` | `0` = **永不按时间回收**，关掉页面/断网后终端继续在后台跑，可以一直连开几天。只有程序自己退出才被清理 |
| 最大同时会话数 | `32` | 1–64。达到上限后**拒绝新建**并提示你关标签页，不会杀掉你正在用的会话 |
| 严格校验管理员身份 | 开 | 关掉后仅依赖网关登录态（网关行为异常时的兜底） |

---

## 5. 文件位置

安装后（`/var/apps/nas-webterm/` 是符号链接集合，实际落在应用中心选择的卷）：

| 路径 | 内容 |
| --- | --- |
| `${TRIM_APPDEST}/server/nas-webterm-<arch>` | 服务二进制（按 CPU 架构自动选择） |
| `${TRIM_APPDEST}/ui/` | 前端静态资源 |
| `${TRIM_APPDEST}/app.sock` | 网关 socket |
| `${TRIM_PKGVAR}/info.log` | 运行日志（启动、会话回收、错误） |
| `${TRIM_PKGVAR}/settings.env` | 配置持久化 |
| `${TRIM_PKGVAR}/webterm.pid` | 进程号 |

常用排查命令：

```bash
sudo tail -f /var/apps/nas-webterm/var/info.log
sudo /var/apps/nas-webterm/cmd/main status   # 0=运行中 3=已停止
sudo /var/apps/nas-webterm/cmd/main stop
sudo /var/apps/nas-webterm/cmd/main start
```

---

## 6. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 桌面没有图标 | 只有管理员能看到；换管理员账号登录 |
| 页面空白或提示 403 | 非管理员；或「严格校验管理员身份」与网关行为冲突，可临时关闭该项 |
| 页面能开但终端不出现 | 看 `info.log`；多为 shell 路径不存在（改回 `/bin/bash`） |
| 提示「会话已结束」，点红点 | PTY 进程退出，点标签上的红点可重启该标签的会话 |
| 打开 TUI 后一片空白、但普通命令正常 | 这是前端终端库解析某些能力查询序列时的缺陷（1.0.1 已修）。升级到 1.0.1 或更新版本；回归用 `node tools/verify-vt.mjs --url ...` 自测 |
| 升级后新标签页仍自动执行某条命令 | 旧版本（1.0.0）默认带了一条命令。1.0.1 的升级向导里勾选「清空新标签页自动执行的命令」即可；也可在应用设置里手动清空后保存 |
| 想让终端一直挂着不被回收 | 默认就是永不回收（「会话空闲回收 = 0」）。只有你自己关标签页、或程序自己退出时才会结束 |
| 长时间不动后终端断开 | 网关 `proxy_read_timeout` 是 300 秒，服务端每 20 秒发一次心跳保活；若仍断开，检查中间是否有别的反向代理 |
| 中文显示成方块 | NAS 上缺少中文字体；容器/最小系统可装 `fonts-wqy-zenhei`（只影响浏览器渲染，服务端不涉及） |

---

## 7. 开发

```bash
# 后端（Rust 1.75+）
cd rust && cargo build --release

# 前端（Node 18+）
cd web && npm install
npx tsc --noEmit            # 类型检查
npx vite build && node scripts/postbuild.mjs

# 本地预览（TCP 端口，不走网关）
./tools/dev.sh              # http://127.0.0.1:18086/app/nas-webterm/
```

### 目录结构

```
nas-webterm/
├── manifest                 # 应用清单
├── config/{privilege,resource}
├── wizard/{install,upgrade,uninstall,config}
├── cmd/                     # 生命周期脚本（start/stop/status + 安装升级卸载回调）
├── app/
│   ├── server/              # 构建产物：nas-webterm-{x86_64,aarch64}
│   └── ui/                  # 构建产物：前端 + 桌面入口配置 config
├── rust/                    # Rust 后端源码
│   └── src/{main,config,proto,session,web,log}.rs
├── web/                     # TypeScript 前端源码
│   └── src/{main,app,terminal}.ts + style.css
└── tools/                   # 开发、测试、打包校验脚本
```

### 后端模块

| 文件 | 职责 |
| --- | --- |
| `main.rs` | 参数解析、运行时初始化、unix socket 监听、优雅退出 |
| `config.rs` | 全部启动参数（由 `cmd/main` 依据 `TRIM_*` 注入） |
| `session.rs` | PTY 会话：spawn、读写线程、回放缓冲、尺寸调整、空闲回收、进程组清理 |
| `proto.rs` | WebSocket 二进制帧协议 |
| `web.rs` | 路由、静态资源、REST、WebSocket 数据通道、管理员校验、安全响应头 |
| `log.rs` | 极简日志（stderr + 文件） |

### 重连时全屏程序为什么不会乱

全屏 TUI 会切到**备用屏幕**并持续重绘。重连时如果把原始字节流直接灌进终端，
会出现两个问题：回放缓冲被上限截断在一条转义序列中间，以及客户端没先进备用屏幕、
TUI 的重绘被画到主屏上。处理方式：

1. 服务端跟踪会话当前是否处于备用屏幕（扫描输出里的 `ESC[?1049h` / `ESC[?1049l`）；
2. 回放内容按**转义序列边界**裁剪，而不是按换行——TUI 的重绘输出里根本没有换行，
   按换行裁会把整段回放丢掉，重连后就是一片空白；
3. 回放里若已不带「进入备用屏幕」那个起点，客户端会先补一条 `ESC[?1049h` 再回放；
4. 回放完成后给前台进程组发一个 `SIGWINCH`，会响应它的 TUI 会自己把界面重画一遍。

回归测试：`tools/verify-reconnect-tui.mjs`（协议层）与
`tools/verify-reconnect-browser.mjs`（浏览器级「关掉页面再打开」）。

### 帧协议

二进制帧，第一字节是类型，后面是负载。终端数据不加转义、不 base64，避免 TUI 高频重绘的额外开销。

| 方向 | 类型 | 负载 |
| --- | --- | --- |
| C→S | `0x01` INPUT | 原始键盘字节 |
| C→S | `0x02` RESIZE | JSON `{"cols":N,"rows":M}` |
| C→S | `0x03` SIGNAL | JSON `{"signal":"INT"}` |
| S→C | `0x01` OUTPUT | 原始终端输出 |
| S→C | `0x02` EXIT | JSON `{"code":N,"signal":N|null}` |
| S→C | `0x03` READY | JSON `{"sid","shell","cwd","pid","cols","rows","altScreen","needAltEnter"}` |

---

## 8. 构建与测试

```bash
./build.sh                  # 双架构编译 + 前端构建 + 冒烟测试 + fnpack 打包 + 产物校验
./build.sh --with-browser    # 额外跑 headless 浏览器交互验证（需要 chromium）
./build.sh --arch x86_64     # 只出一个架构
```

交叉编译 aarch64 需要：`sudo apt install gcc-aarch64-linux-gnu`（脚本已配置 linker）。

### 测试套件

| 脚本 | 覆盖 |
| --- | --- |
| `tools/smoke-test.sh` | 19 项：start/stop/status 幂等、socket 权限、首页与资源、REST、403、WS 101、路径穿越 |
| `tools/verify-browser.mjs` | headless Chromium：页面渲染、资源无失败、相对 API、WS、真实键入（标记由 shell 计算，避免假阳性）、无 JS 异常、截图 |
| `tools/verify-vt.mjs` | **VT 兼容性回归**：DECRQM/DA1/OSC 10-11 等终端能力查询序列不崩解析器，alt-screen 往返后仍能输出 |
| `tools/verify-tui-app.mjs` | 全屏 TUI 程序端到端：界面真的画出来、无异常、按键能被接收（`--cmd` 指定程序，默认 htop） |
| `tools/verify-reconnect-tui.mjs` | 全屏 TUI 断线重连：断开 → 等待 → 重连，界面必须正确重建 |
| `tools/verify-reconnect-browser.mjs` | 浏览器级「关掉页面再打开」：标签页恢复、TUI 画面还原、无转义残渣 |
| `tools/verify-features.mjs` | **全功能 18 项**：READY/退出码、PTY 尺寸同步（stty 实测）、括号粘贴、中文 UTF-8、真彩色穿透、Ctrl+C、会话隔离、容量上限拒绝新建、断线重连回放、未知帧容错 |
| `tools/verify-leaks.mjs` | **后端泄漏**：反复建/销会话，监控 RSS / fd / 线程 / 僵尸进程 |
| `tools/verify-front-leaks.mjs` | **前端泄漏**：反复建/销标签页，监控 JS 堆 / DOM 节点 / 终端实例数 |
| `tools/verify-tabs.mjs` | 12 项：多标签独立 PTY、输出隔离、刷新恢复、回放、关闭回收 |
| `tools/tui-check.mjs` | 全屏 TUI：alt-screen、持续重绘、尺寸调整、Ctrl+C 退出 |
| `tools/ws-check.mjs` | WebSocket 通道：READY 帧、命令回显 |
| `tools/verify-fpk.sh` | 官方结构校验 + Rust 载荷（双架构 ELF、无开发产物、注入点） |

已执行的验证结果见 `docs/screenshots/`。

### 前端终端库版本锁定（重要）

`web/package.json` 把 `@xterm/xterm` 固定在 **5.5.0**。原因：6.0.0 的 DECRQM（`CSI ? n $ p`）
处理代码引用了未声明变量，全屏 TUI 程序启动时往往会发送一批终端能力查询，解析器当场抛
`ReferenceError` 并停止工作，屏幕永久空白——普通 shell 完全正常，只有 TUI 打不开，很容易误判成后端问题。

升级前端终端库前，必须先跑这两个测试：

```bash
node tools/verify-vt.mjs --url http://127.0.0.1:18086/app/nas-webterm/     # 合成能力查询序列回归
node tools/verify-tui-app.mjs --url http://127.0.0.1:18086/app/nas-webterm/ --cmd htop
```

`verify-vt.mjs` 的断言标记由 `printf 'VT-%s' OK` 拼出，命令行回显里不含完整标记，
所以只有真正的程序输出能让它通过。

---

## 9. 已知限制

1. **root shell 是刻意的**：任何能登录飞牛管理员的账号都能拿到 root。若只想给普通用户用，请把 `config/privilege` 的 `run-as` 改成应用用户，并在 `cmd/main` 里去掉 root 相关参数——但那就不再是完整终端了。
2. **某些程序自带后台服务**：个别程序会在本机开一个固定端口的后台服务，同一用户下开多个实例时会争用该端口。这与本应用无关，在普通终端里也会同样报错。
3. **未做终端分屏/窗格**：一个标签页对应一个 PTY，分屏请开多个标签页。
4. **断线回放上限 256KB**：只回放最近的输出，更早的滚动历史不保留（刷新前可用终端自身回滚缓冲，上限 8000 行）；刷新后回到终端底部。
5. **未适配移动端手势**：手机浏览器可用，但没有做虚拟键盘栏、滑动滚动等专门优化。

---

## 10. 许可证

MIT，见 `LICENSE`。
