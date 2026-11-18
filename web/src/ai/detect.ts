/**
 * 输入意图识别：这一行到底是 shell 命令，还是对 AI 说的话？
 *
 * 必须在按下回车的那一瞬间同步完成（不能等一次网络往返），所以规则全在前端。
 *
 * 这里刻意**不写死命令表**：命令名来自服务端扫描 PATH 得到的清单
 * （`GET api/ai/commands`）。写死一张表永远会漏掉用户自己装的工具
 * （opencode、lazygit、fnpack…），而漏掉的后果是把命令当成一句话发给 AI。
 *
 * 判断顺序（先命中先返回）：
 *   1. `!` 前缀 → 强制当命令（去掉前缀）
 *   2. `#` / `?` 前缀 → 强制当自然语言（去掉前缀）
 *   3. 多行：每一行都像命令 → 命令；否则自然语言
 *   4. 含 shell 元字符（管道、重定向、通配、变量…）→ 命令
 *   5. 首个可执行 token（跳过 sudo/env/timeout…）是路径或已知命令 → 命令
 *   6. 带 `-x` / `--long` 参数 → 命令
 *   7. 多词纯英文、首词是「英文单词也是命令」的歧义词 → 自然语言
 *   8. 其余（含中文、未知单词、英文句子）→ 自然语言
 */

/**
 * shell 元字符：出现即认为是命令行。
 *
 * 只保留「几乎不可能出现在英文句子里」的一批：管道、重定向、命令分隔、变量与
 * 命令替换、通配、赋值。括号、方括号、反斜杠这类在自然语言里也可能出现，
 * 放进来会把「check (please)」这样的句子误判成命令。
 */
const META = /[|><;&$`*=]/;

/** 前缀命令：它们后面才是真正执行的命令 */
const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'exec', 'command', 'builtin', 'time', 'nohup', 'setsid',
  'strace', 'ltrace', 'watch', 'xargs', 'eval', 'nice', 'ionice', 'stdbuf',
  'proxychains', 'proxychains4', 'torsocks', 'timeout',
]);

/** 前缀命令自身的选项/参数形态（`-u`、`-n 5`、`FOO=1`） */
const WRAPPER_ARG = /^(-[A-Za-z0-9]+|[0-9]+|[A-Za-z_][A-Za-z0-9_]*=[^\s]*|[0-9]+[smhdw]$)/;

/** `sudo -u root ls`：`-u` 后面那个值是用户名，不是命令 */
const WRAPPER_VALUE_OPTS = new Set(['-u', '--user', '-g', '--group', '-p', '--prompt', '-h']);

/**
 * 既是常见英文单词、又是真实可执行文件的命令名。
 * 整行是多个纯英文单词、且首词命中这里时，按自然语言处理。
 */
const AMBIGUOUS = new Set([
  'install', 'find', 'test', 'make', 'touch', 'watch', 'sort', 'head', 'tail', 'cut',
  'date', 'host', 'open', 'say', 'more', 'less', 'man', 'info', 'time', 'which', 'type',
  'file', 'read', 'play', 'look', 'print', 'dir', 'sleep', 'wait', 'id', 'at', 'batch',
  'yes', 'join', 'split', 'paste', 'tr', 'expr', 'size', 'stat', 'kill', 'stop', 'start',
  'run', 'build', 'check', 'get', 'set', 'list', 'show', 'new', 'add', 'copy', 'move',
  'remove', 'help', 'search', 'count', 'echo',
]);

export type InputKind = 'command' | 'natural';

export interface DetectResult {
  kind: InputKind;
  /** 去掉强制前缀之后的实际文本 */
  text: string;
}

export interface DetectOptions {
  /** PATH 里的可执行文件 + shell 内建 + 别名（服务端下发，统一小写） */
  commands?: ReadonlySet<string>;
}

/** 中日韩字符：出现即说明这是人话，不是敲命令。 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;

export function detectKind(raw: string, opts: DetectOptions = {}): DetectResult {
  const input = raw.replace(/\s+$/, '');
  if (!input.trim()) return { kind: 'command', text: input };

  const trimmed = input.trimStart();

  if (trimmed.startsWith('!')) {
    return { kind: 'command', text: trimmed.slice(1).trim() };
  }
  if (trimmed.startsWith('#') || trimmed.startsWith('?')) {
    return { kind: 'natural', text: trimmed.slice(1).trim() };
  }

  const lines = input.split('\n').filter((l) => l.trim());
  if (lines.length > 1) {
    const allCommands = lines.every((l) => looksLikeCommand(l, opts));
    return { kind: allCommands ? 'command' : 'natural', text: input };
  }

  return { kind: looksLikeCommand(input, opts) ? 'command' : 'natural', text: input };
}

function looksLikeCommand(line: string, opts: DetectOptions): boolean {
  const s = line.trim();
  if (!s) return false;

  const tokens = s.split(/\s+/);

  // 首词含中日韩字符 → 那是人话（中文不会是命令名）。
  // 只判首词是为了保住 `cat 你好.txt`、`grep 中文 note.md`：命令名是英文、
  // 中文只作为参数时仍然是命令。要强制执行中文开头的命令，用 `!` 前缀。
  if (CJK.test(tokens[0])) return false;

  // 管道、重定向、通配、变量展开：典型的命令行
  if (META.test(s)) return true;

  // 单个 ASCII token（整行没有空格）：几乎一定是在敲命令。
  // 即使它不在 PATH 清单里（拼错、刚装的工具、大写缩写 `OMP`），
  // 也应该交给 shell 让 bash 报 command not found，
  // 而不是把它当成一句话丢给 AI。想强制问 AI 用 `?` 前缀。
  if (tokens.length === 1 && !CJK.test(tokens[0]) && /^[\x21-\x7e]+$/.test(tokens[0])) {
    return true;
  }

  const head = firstExecutableToken(tokens);
  if (!head) return false;

  const known = isKnownCommand(head, opts);

  // 多词纯英文、首词是歧义词 → 英文句子，交给 AI。
  // 这一步必须排在「已安装命令」之前：install / find / date 都是真实程序，
  // 只看 PATH 会把 `install docker please` 当命令。
  if (tokens.length >= 3 && tokens.every(isPureWord) && AMBIGUOUS.has(head.toLowerCase())) {
    return false;
  }

  // 路径形式一定是命令：./deploy.sh、/usr/bin/htop、~/bin/x
  if (head.includes('/') || head.startsWith('~')) return true;

  // 已安装的命令一定当命令执行——即使后面跟了中文参数（`cat 你好.txt`）
  if (known) return true;

  // 带参数（`opencode --help`、`foo -v`）几乎一定是命令：
  // 英语句子里很少出现 `-x` / `--long` 这种裸参数。
  if (tokens.slice(1).some(isOption)) return true;

  // 变量赋值开头：`FOO=1 make`（前面已按 META 的 `=` 命中，这里兜底）
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return true;

  // 其余（含中文、未知单词、英文句子）→ 自然语言
  return false;
}

function isKnownCommand(head: string, opts: DetectOptions): boolean {
  if (!opts.commands || opts.commands.size === 0) return false;
  const lower = head.toLowerCase();
  if (opts.commands.has(lower)) return true;
  // 服务端清单可能带 `.exe` 之类的后缀，这里不做模糊匹配，避免误判。
  return false;
}

function isOption(token: string): boolean {
  return /^--?[A-Za-z0-9]/.test(token);
}

function isPureWord(token: string): boolean {
  return /^[a-zA-Z]+$/.test(token);
}

/**
 * 找到真正被执行的 token：跳过 `sudo`、`-u root`、`env FOO=1`、`timeout 10` 等。
 */
function firstExecutableToken(tokens: string[]): string | null {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!WRAPPERS.has(tok.toLowerCase())) return tok;
    i += 1;
    // 跳过前缀命令的选项与它们的取值
    while (i < tokens.length) {
      const arg = tokens[i];
      if (WRAPPER_VALUE_OPTS.has(arg)) {
        i += 2;
        continue;
      }
      if (WRAPPER_ARG.test(arg)) {
        i += 1;
        continue;
      }
      break;
    }
  }
  return null;
}
