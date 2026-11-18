#!/usr/bin/env python3
"""把普通版目录里的源码剥离成「完全不含 AI 代码」的样子。

做的事：
  1. Rust：Cargo.toml 去掉 ai feature；main.rs / web.rs / session.rs / config.rs
     去掉 `#[cfg(feature = "ai")]` 门控与 AI 专属代码。
  2. 前端：web/src/ai/ 整个目录删除，app.ts 改用本地空实现。

普通版目录因此是**自洽可编译**的：不是「编译时跳过 AI」，而是「源码里就没有 AI」。

用法：python3 tools/strip-ai-source.py <普通版目录>
"""

import os
import re
import shutil
import sys


def die(msg: str) -> None:
    print(f"strip-ai-source: {msg}", file=sys.stderr)
    sys.exit(1)


def read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def strip_rust(root: str) -> None:
    rust = os.path.join(root, "rust")
    if not os.path.isdir(rust):
        die(f"找不到 {rust}")

    # 1) Cargo.toml：去掉 ai feature
    cargo = os.path.join(rust, "Cargo.toml")
    text = read(cargo)
    text = re.sub(
        r"\[features\]\n(?:#.*\n)*default\s*=\s*\[\"ai\"\]\nai\s*=\s*\[\]\n\n",
        "",
        text,
    )
    write(cargo, text)

    # 2) main.rs：逐行精确处理（正则对这种带缩进的代码容易误伤）
    main = os.path.join(rust, "src", "main.rs")
    if os.path.exists(main):
        lines = read(main).split("\n")
        out = []
        pending_mod_ai = False
        skip_cfg_for_mod = False
        for line in lines:
            stripped = line.strip()
            # 模块声明：形如
            #   #[cfg(feature = "ai")]
            #   mod ai;
            # 两行都要删。先记住「下一个是 mod ai;」的标记。
            if stripped == '#[cfg(feature = "ai")]':
                if pending_mod_ai:
                    pending_mod_ai = False
                    continue
                pending_mod_ai = True
                skip_cfg_for_mod = True
                continue
            if stripped == "mod ai;":
                pending_mod_ai = False
                skip_cfg_for_mod = False
                continue
            if skip_cfg_for_mod:
                # cfg 标注后面不是 mod ai;，把标注本身去掉，保留后面的代码
                skip_cfg_for_mod = False
            # AI 相关的字段与语句
            if stripped in (
                "let ai_store = Arc::new(ai::AiStore::load(cfg.ai_config.clone()));",
                "ai: ai_store,",
                "agents: Arc::new(ai::agent::AgentStore::new()),",
            ):
                continue
            # AI 专属的注释
            if stripped.startswith("// AI 助手：普通版编译时就没有这个模块"):
                continue
            if stripped == '#[cfg(feature = "ai")]':
                continue
            out.append(line)
        text = "\n".join(out)
        # 兜底：只删 cfg 标注本身（连带它上面的注释），
        # 不能连后面的语句一起删——那样会把代码删坏。
        text = re.sub(
            r"[ \t]*//[^\n]*\n[ \t]*#\[cfg\(feature = \"ai\"\)\]\n",
            "",
            text,
        )
        text = re.sub(r"[ \t]*#\[cfg\(feature = \"ai\"\)\]\n", "", text)
        write(main, text)

    # 3) web.rs
    web = os.path.join(rust, "src", "web.rs")
    if os.path.exists(web):
        text = read(web)
        text = re.sub(
            r"    /// AI 助手配置（API Key 只存在后端，接口返回掩码）。\n"
            r"    ///\n"
            r"    /// 普通版编译时没有 `feature = \"ai\"`，这个字段连同相关代码都不存在。\n"
            r"    #\[cfg\(feature = \"ai\"\)\]\n"
            r"    pub ai: .*?\n"
            r"    /// 进行中的 agent 任务（终端内 AI 模式）\n"
            r"    #\[cfg\(feature = \"ai\"\)\]\n"
            r"    pub agents: .*?\n",
            "",
            text,
        )
        text = re.sub(
            r"    // AI 路由：普通版编译时这段代码不存在，接口也不会被注册\n"
            r"    #\[cfg\(feature = \"ai\"\)\]\n"
            r"    let api = crate::ai::routes::register_routes\(api, state\.clone\(\), &prefix\);\n",
            "",
            text,
        )
        text = text.replace(
            '            "aiEnabled": cfg!(feature = "ai"),',
            '            "aiEnabled": false,',
        )
        # 兜底：只删 cfg 标注本身（连带它上面的注释），
        # 不能连后面的语句一起删——那样会把代码删坏。
        text = re.sub(
            r"[ \t]*//[^\n]*\n[ \t]*#\[cfg\(feature = \"ai\"\)\]\n",
            "",
            text,
        )
        text = re.sub(r"[ \t]*#\[cfg\(feature = \"ai\"\)\]\n", "", text)
        write(web, text)

    # 4) session.rs：去掉门控标注
    session = os.path.join(rust, "src", "session.rs")
    if os.path.exists(session):
        text = read(session)
        # 成对的 AI-only 区块整段删除（例如提示符完成标记的注入）。
        # 普通版既没有 AI 层，也不需要覆盖用户的 PROMPT_COMMAND。
        text = re.sub(
            r"[ \t]*// AI-ONLY-BEGIN[^\n]*\n([\s\S]*?)[ \t]*// AI-ONLY-END[^\n]*\n",
            "",
            text,
        )
        # 区块删除后可能留下紧贴的文档注释；把孤立的注释行也清掉，
        # 避免普通版源码里出现指向不存在函数的说明。
        text = re.sub(r"\n/// 提示符标记前缀。[^\n]*\n(?=\n|///|fn |pub |#\[|struct |enum |impl |const |static |mod |use )", "\n", text)
        text = re.sub(r"\n/// 是否 bash：[^\n]*\n(?=\n|///|fn |pub |#\[|struct |enum |impl |const |static |mod |use )", "\n", text)
        # 标记只在 AI 版里有意义；普通版删除对应的方法与文档注释，
        # 避免留下引用 prompt_marker_prefix / shell_is_bash 的孤儿函数。
        for pattern in (
            r"\n[ \t]*///[^\n]*\n(?:[ \t]*///[^\n]*\n)*(?:[ \t]*#\[[^\n]*\]\n)*[ \t]*pub(?:\s+(?:async\s+)?fn) supports_prompt_marker[\s\S]*?\n    \}\n",
            r"\n[ \t]*///[^\n]*\n(?:[ \t]*///[^\n]*\n)*(?:[ \t]*#\[[^\n]*\]\n)*[ \t]*pub(?:\s+(?:async\s+)?fn) prompt_marker_prefix[\s\S]*?\n    \}\n",
            r"\n[ \t]*///[^\n]*\n(?:[ \t]*///[^\n]*\n)*(?:[ \t]*#\[[^\n]*\]\n)*[ \t]*fn marker_owner_matches[\s\S]*?\n    \}\n",
            r"\n[ \t]*///[^\n]*\n(?:[ \t]*///[^\n]*\n)*(?:[ \t]*#\[[^\n]*\]\n)*[ \t]*pub(?:\s+(?:async\s+)?fn) wait_for_prompt[\s\S]*?\n    \}\n",
        ):
            text = re.sub(pattern, "\n", text)
        text = text.replace('    #[cfg(feature = "ai")]\n', "")
        text = text.replace('#[cfg(feature = "ai")]\n', "")
        # wait_quiet 的文档里提到 wait_for_prompt；普通版没有后者，改掉这句说明。
        text = text.replace(
            "    /// bash 会话一律用 `wait_for_prompt`。\n",
            "    /// bash 会话在 AI 版里用提示符标记判断；普通版没有 AI，不走这条路径。\n",
        )
        write(session, text)

    # 5) config.rs：去掉 ai_config 字段（逐行处理）
    cfg = os.path.join(rust, "src", "config.rs")
    if os.path.exists(cfg):
        lines = read(cfg).split("\n")
        out = []
        for line in lines:
            stripped = line.strip()
            if stripped == "pub ai_config: Option<PathBuf>,":
                # 连带删掉它上面的文档注释
                while out and out[-1].strip().startswith("///"):
                    out.pop()
                continue
            if stripped == "ai_config: None,":
                continue
            if stripped.startswith('"--ai-config" =>'):
                continue
            out.append(line)
        write(cfg, "\n".join(out))


EMPTY_BRIDGE = """/**
 * AI 桥接（普通版）：空实现。
 *
 * 普通版没有 AI 助手，所有方法都是空操作——页面上没有 AI 面板，
 * 终端输入也不会被 AI 拦截。
 */

export interface AiBridge {
  readonly enabled: boolean;
  readonly visible: boolean;
  init(): Promise<void>;
  setVisible(visible: boolean, remember?: boolean): void;
  toggle(): void;
  submitText(text: string): void;
  stop(): void;
  reset(): void;
  openSettings(): void;
  isVisible(): boolean;
  writeActiveInput(text: string): void;
}

export const AI_BRIDGE: AiBridge = {
  enabled: false,
  visible: false,
  async init() {},
  setVisible() {},
  toggle() {},
  submitText() {},
  stop() {},
  reset() {},
  openSettings() {},
  isVisible: () => false,
  writeActiveInput() {},
};
"""


def strip_web(root: str) -> None:
    web = os.path.join(root, "web")
    if not os.path.isdir(web):
        die(f"找不到 {web}")

    # 1) 删掉整个 ai 目录
    ai_dir = os.path.join(web, "src", "ai")
    if os.path.isdir(ai_dir):
        shutil.rmtree(ai_dir)

    # 2) 内置 Nerd Font 子集不是 AI 代码，两个版本都要有（误删会导致图标变方块）
    font = os.path.join(web, "src", "fonts", "nerd.woff2")
    if not os.path.exists(font):
        die(f"普通版缺少内置 Nerd Font 子集: {font}")

    # 3) 删掉只被 AI 用的模块（协议标签过滤、Markdown 渲染）
    for name in ("tool-filter.ts", "md-html.ts"):
        p = os.path.join(web, "src", name)
        if os.path.exists(p):
            os.remove(p)

    # 4) app.ts：bridge 换成固定的空实现
    app = os.path.join(web, "src", "app.ts")
    if os.path.exists(app):
        text = read(app)
        text = text.replace(
            "import { AI_BRIDGE, createAiBridge } from './variant-bridge';\n"
            "import type { AiBridge } from './ai/bridge';",
            "// 普通版没有 AI 助手：所有 AI 调用都是空操作。\n"
            "import { AI_BRIDGE } from './ai-bridge';\n"
            "import type { AiBridge } from './ai-bridge';",
        )
        text = re.sub(
            r"  private async initAi\(\): Promise<void> \{\n"
            r"    // AI 版在这里把空实现换成真实现.*?\n"
            r"    this\.ai = createAiBridge\(\{.*?\n"
            r"    \}\);\n"
            r"    await this\.ai\.init\(\);",
            "  private async initAi(): Promise<void> {\n"
            "    await this.ai.init();",
            text,
            flags=re.S,
        )
        write(app, text)

    # 5) 本地空实现（替代被删掉的 ai/bridge.ts）
    write(os.path.join(web, "src", "ai-bridge.ts"), EMPTY_BRIDGE)

    # 6) main.ts
    main = os.path.join(web, "src", "main.ts")
    if os.path.exists(main):
        text = read(main)
        text = text.replace("  let aiEnabled = true;\n", "")
        text = re.sub(
            r"\n\s*// 普通版服务端返回 false：整个 AI 面板与入口都不出现\n"
            r"\s*aiEnabled = json\.data\?\.aiEnabled !== false;",
            "",
            text,
        )
        text = text.replace(
            "const app = new App({ base, fontSize: 14, startupCommand, aiEnabled });",
            "const app = new App({ base, fontSize: 14, startupCommand });",
        )
        write(main, text)

    # 7) 删掉变体入口（普通版固定用空实现）
    p = os.path.join(web, "src", "variant-bridge.ts")
    if os.path.exists(p):
        os.remove(p)


def main() -> None:
    if len(sys.argv) != 2:
        die("用法: python3 tools/strip-ai-source.py <普通版目录>")
    root = sys.argv[1]
    if not os.path.isdir(root):
        die(f"目录不存在: {root}")
    strip_rust(root)
    strip_web(root)
    print(f"strip-ai-source: {root} 已剥离为纯终端版本")


if __name__ == "__main__":
    main()
