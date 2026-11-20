#!/usr/bin/env node
/**
 * whale-utero-suite —— 「鲸鱼娘生理扩展」+ 对话同步 的通用补丁脚本
 *
 * 它做两件事，且两件都是幂等的（重复跑不会叠加）：
 *   1. 给 dsh-whale-utero 的 client.js 注入手机端适配 CSS（≤820px：放不下的
 *      内容一律改成可滑动，而不是被 overflow:hidden 裁掉）。注入区用
 *      `utero-mobile-patch:begin/end` 标记包住，下次 apply 直接整段替换——
 *      所以「插件升级覆盖了补丁」之后重跑一次即可恢复。
 *   2. 落盘并注册 utero-sync 插件：读鲸鱼娘每 5s 落盘的 data/state.json，
 *      用 systemPrompt.section 把精简状态 + 情景协议注入对话，并注册
 *      utero_scene 工具供模型在闲聊时按需取情景素材。
 *
 * 部署前会先做环境检测（见 detect）：
 *   · 本体在不在、装在哪个 profile；
 *   · 当前跑的是哪个 profile（--profile → 环境变量 → 运行中进程 → 唯一/最近活跃）；
 *   · 这个 profile 有没有客户端面（web/desktop 才有 client.js，headless/acp/sdk 没有）；
 *   · 宿主是什么（android-dshbox / linux / darwin / win32）、DSH 与 Node 版本。
 * 然后按环境自适应：
 *   · 有客户端面 → 打 CSS 补丁 + 装 utero-sync；
 *   · 纯 host 面   → 跳过 CSS（无处生效），只装 utero-sync；
 *   · 本体缺失     → 默认只提示安装命令，加 --install-whale 才会自动装。
 *
 * 为什么补丁不能直接改在插件包里：dsh-whale-utero 是从 github 装的第三方包，
 * 每次 `dsh plugin add` 升级都会整份覆盖 node_modules 里那个目录。
 *
 * 用法：
 *   node apply.mjs detect           # 只读：环境检测报告（不做任何写操作）
 *   node apply.mjs status           # 只读：补丁与插件当前状态
 *   node apply.mjs apply            # 自适应部署（--dry-run 只预览）
 *   node apply.mjs apply --install-whale   # 本体缺失时自动安装
 *   node apply.mjs revert           # 还原 client.js，并从 profile 摘掉 utero-sync
 *
 * 常用参数：--profile <name> / --dry-run / --no-install / --css=force|off
 * 环境变量：DSH_HOME、DSH_PROFILE、UTERO_SYNC_MODE、UTERO_SYNC_OFF、WHALE_UTERO_STATE
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD = path.join(HERE, 'payload');

const BEGIN_PREFIX = '/* === utero-mobile-patch:begin';
const END_MARK = '/* === utero-mobile-patch:end === */';
const INSERT_ANCHOR = '@media (prefers-reduced-motion:reduce)';
const PLUGIN_NAME = 'utero-sync';
const WHALE_PKG = 'dsh-whale-utero';
const WHALE_SPEC = 'github:TianhuMoMo/DSH-shengli';

/** 会在浏览器里渲染界面的 bundle：只有它们才消费 client.js。 */
const CLIENT_BUNDLES = ['@deepseek-ai/dsh-web-app'];
/** 纯 host 面、没有浏览器客户端的 bundle。 */
const HOST_ONLY_BUNDLES = [
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
];

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const args = {
    command: 'status',
    dryRun: false,
    install: true,
    installWhale: false,
    profile: null,
    css: 'auto', // auto | force | off
    dshVersion: null,
    dshHome: null,
  };
  const rest = [...argv];
  if (rest.length > 0 && !rest[0].startsWith('-')) args.command = rest.shift();
  while (rest.length > 0) {
    const token = rest.shift();
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--no-install') args.install = false;
    else if (token === '--install-whale') args.installWhale = true;
    else if (token === '--no-css') args.css = 'off';
    else if (token === '--force-css') args.css = 'force';
    else if (token === '--css=force') args.css = 'force';
    else if (token === '--css=off') args.css = 'off';
    else if (token === '--css=auto') args.css = 'auto';
    else if (token === '--profile') args.profile = rest.shift() ?? null;
    else if (token.startsWith('--profile=')) args.profile = token.slice('--profile='.length);
    else if (token === '--dsh-version') args.dshVersion = rest.shift() ?? null;
    else if (token.startsWith('--dsh-version=')) args.dshVersion = token.slice('--dsh-version='.length);
    else if (token === '--dsh-home') args.dshHome = rest.shift() ?? null;
    else if (token.startsWith('--dsh-home=')) args.dshHome = token.slice('--dsh-home='.length);
    else if (token === '--help' || token === '-h') args.command = 'help';
    else throw new Error(`未知参数：${token}`);
  }
  return args;
}

/* ------------------------------------------------------------------ 路径 */

let homeCache = null;

/**
 * 解析 $DSH_HOME。优先级：--dsh-home → DSH_HOME → 各端的默认位置 → ~/.dsh。
 * 桌面版（Electron）用的是自己的目录：Windows 在 %APPDATA%\dsh-desktop\harness，
 * macOS 在 ~/Library/Application Support/dsh-desktop/harness，
 * Linux 在 ~/.config/dsh-desktop/harness；浏览器端（CLI/web）才是 ~/.dsh。
 * 判断依据是"那个目录下有 profiles/"，而不是猜。
 */
function dshHome() {
  if (homeCache) return homeCache;
  const env = process.env.DSH_HOME;
  if (env) return (homeCache = env);
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'dsh-desktop', 'harness'));
  }
  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness'));
  }
  candidates.push(path.join(home, '.config', 'dsh-desktop', 'harness'));
  candidates.push(path.join(home, '.dsh'));
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'profiles'))) return (homeCache = dir);
    } catch {
      // 下一个候选
    }
  }
  return (homeCache = candidates[candidates.length - 1] ?? path.join(home, '.dsh'));
}

function setDshHome(dir) {
  if (typeof dir === 'string' && dir.trim()) {
    homeCache = dir.trim();
    process.env.DSH_HOME = homeCache;
  }
}

function profilesRoot() {
  return path.join(dshHome(), 'profiles');
}

function clientPathOf(profileDir) {
  return path.join(profileDir, 'node_modules', WHALE_PKG, 'client.js');
}

function statePathOf(profileDir) {
  return path.join(profileDir, 'node_modules', WHALE_PKG, 'data', 'state.json');
}

function mtimeOf(target) {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------ 环境检测 */

/** 宿主类型：Android 上的 DSHBox（proot 容器）要单独认，它的路径与权限都不一样。
 *  只靠 process.platform 认不出来——proot 里 node 看到的是 linux；真实信号有三类：
 *  内核 release 带 `-android`、环境里有 MOZ_ANDROID_* / PROOT_* / ANDROID_*、
 *  或者任何 env 值里出现 com.dshbox.app。 */
function hostKind() {
  const release = os.release();
  const androidKernel = /-android/i.test(release) || process.platform === 'android';
  let dshbox = false;
  try {
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value !== 'string') continue;
      if (value.includes('com.dshbox.app')) { dshbox = true; break; }
      if (/^(MOZ_ANDROID|PROOT_|ANDROID_|ANDROID$)/.test(key)) dshbox = true;
      if (dshbox) break;
    }
  } catch {
    // env 读不了就按内核判断
  }
  if (dshbox && androidKernel) return 'android-dshbox（proot）';
  if (dshbox) return 'android-dshbox';
  if (androidKernel) return 'android';
  return process.platform; // linux / darwin / win32
}

/** 客户端内核：宿主给子进程带的 Android/Gecko 环境变量能反推是哪种 WebView。 */
function clientKernel() {
  const env = process.env;
  if (env.MOZ_ANDROID_LIBDIR || env.MOZ_ANDROID_CPU_ABI) return 'geckoview';
  if (env.ANDROID_ROOT || /-android/i.test(os.release())) return 'system-webview（或未知）';
  return null;
}

/** 本补丁支持的 DSH 最低版本。utero-sync 只用 systemPrompt.section + tools.register，
 *  这两个服务在 0.1.x 就已存在（dsh-core-memory 的 README 明确写 0.1.x 兼容），
 *  所以门槛是 0.1.5 而不是 0.2.x。客户端 CSS 补丁与版本无关，任何版本都只是字符串注入。 */
const MIN_DSH = '0.1.5';
/** 比较用的门槛下界：`0.1.5-0` 让 0.1.5 的所有预发布（rc/beta）也算通过——
 *  DSH 的发行版几乎全是 -rc.x，写死 '0.1.5' 会把 0.1.5-rc.2 判成不满足。 */
const MIN_DSH_GATE = '0.1.5-0';

function parseVersion(value) {
  const match = String(value ?? '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] ?? '' };
}

/** semver-lite 比较：预发布 < 同号正式版（0.1.5-rc.2 < 0.1.5）。 */
function cmpVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return String(pa.pre).localeCompare(String(pb.pre), undefined, { numeric: true });
}

function dshVersionCandidates() {
  const list = [];
  if (process.env.DSH_RUNTIME) {
    list.push(path.join(process.env.DSH_RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  }
  list.push(path.join('/opt/dshapp/runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  try {
    for (const name of fs.readdirSync(profilesRoot())) {
      list.push(path.join(profilesRoot(), name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
      // dsh-base 与 dsh 同版本发布，作为捆绑运行时缺失时的兜底
      list.push(path.join(profilesRoot(), name, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'));
    }
  } catch {
    // 没有 profiles 目录就用运行时那份
  }
  return list;
}

/** 从运行时目录 / profile 的 node_modules 读 DSH 版本；找不到返回 null（不猜）。 */
function dshVersion() {
  for (const file of dshVersionCandidates()) {
    const pkg = readJson(file);
    if (pkg?.version) return pkg.version;
  }
  return null;
}

/** 版本来源：--dsh-version → DSH_VERSION → 安装目录里读到的。 */
function resolveDshVersion(args) {
  if (args.dshVersion) return { version: args.dshVersion, source: '--dsh-version' };
  const envVersion = (process.env.DSH_VERSION || '').trim();
  if (envVersion) return { version: envVersion, source: '环境变量 DSH_VERSION' };
  const detected = dshVersion();
  return detected ? { version: detected, source: '安装目录' } : { version: null, source: '未找到' };
}

/** 版本门槛：低于 MIN_DSH 直接拒绝（不写盘）；解析不了就放行但标注。 */
function versionGate(info) {
  if (!info.version) return { ok: true, note: '版本未知，跳过门槛检查' };
  if (!parseVersion(info.version)) return { ok: true, note: `版本号无法解析（${info.version}），跳过门槛检查` };
  if (cmpVersion(info.version, MIN_DSH_GATE) < 0) {
    return { ok: false, note: `需要 DSH >= ${MIN_DSH}，当前 ${info.version}` };
  }
  return { ok: true, note: `>= ${MIN_DSH}` };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 单个 profile 的画像：装了什么、有没有客户端面、补丁与插件状态、最近活跃时间。 */
function profileInfo(name) {
  const dir = path.join(profilesRoot(), name);
  const pkg = readJson(path.join(dir, 'package.json')) ?? {};
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const hasClient = bundles.some((b) => CLIENT_BUNDLES.includes(b));
  const hostOnly = !hasClient && bundles.some((b) => HOST_ONLY_BUNDLES.includes(b));
  const whaleIndex = path.join(dir, 'node_modules', WHALE_PKG, 'index.js');
  const clientPath = clientPathOf(dir);
  const clientSrc = fs.existsSync(clientPath) ? fs.readFileSync(clientPath, 'utf8') : '';
  return {
    name,
    dir,
    bundles,
    hasClient,
    hostOnly,
    // 桌面版（Electron）拥有保留的 profiles/desktop，但用的仍是同一套 Web 客户端，
    // 所以判定为 desktop 而不是 web：装机路径、bundles 与 CLI 都独立。
    interface: hasClient ? (name === 'desktop' ? 'desktop' : 'web') : hostOnly ? 'host-only' : 'unknown',
    whale: fs.existsSync(whaleIndex) || fs.existsSync(clientPath),
    hasClientJs: fs.existsSync(clientPath),
    patched: clientSrc.includes(BEGIN_PREFIX) && clientSrc.includes(END_MARK),
    syncRegistered: bundles.includes(PLUGIN_NAME),
    // 活跃度：插件管理日志最新 → 目录 mtime，用来在多个 profile 里挑"正在用的那个"
    lastActive: Math.max(
      mtimeOf(path.join(dir, '.plugin-manager', 'logs')),
      mtimeOf(path.join(dir, 'package.json')),
      mtimeOf(dir),
    ),
  };
}

function listProfiles() {
  let names;
  try {
    names = fs.readdirSync(profilesRoot());
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      try {
        return fs.statSync(path.join(profilesRoot(), name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map(profileInfo);
}

/** 运行中的 profile 线索：环境变量优先，其次扫 /proc 找带 --profile 的 dsh 进程。 */
function runningProfileHint() {
  for (const key of ['DSH_PROFILE', 'DSH_ACTIVE_PROFILE']) {
    const value = (process.env[key] || '').trim();
    if (value) return { name: value, source: `环境变量 ${key}` };
  }
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let cmd = '';
      try {
        cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      } catch {
        continue;
      }
      if (!/\bdsh\b/.test(cmd)) continue;
      const match = cmd.match(/--profile[= ]([A-Za-z0-9_-]+)/);
      if (match) return { name: match[1], source: `运行中进程 pid ${pid}` };
    }
  } catch {
    // /proc 不可读（容器/权限）：退回后面的启发式
  }
  return null;
}

/**
 * 选择目标 profile：
 *   --profile 显式 → 运行中进程/环境变量 → 唯一 profile → 最近活跃 → 'web' 兜底。
 * 每一步都把"为什么选它"记下来，报告里能看见依据。
 */
function pickProfile(args) {
  const all = listProfiles();
  if (all.length === 0) {
    throw new Error(`找不到任何 profile：${profilesRoot()}\n先跑一次 dsh 让 profile 建立起来`);
  }
  if (args.profile) {
    const hit = all.find((p) => p.name === args.profile);
    if (!hit) {
      throw new Error(`profile "${args.profile}" 不存在；现有：${all.map((p) => p.name).join(', ')}`);
    }
    return { profile: hit, all, reason: `--profile ${args.profile}` };
  }
  const hint = runningProfileHint();
  if (hint) {
    const hit = all.find((p) => p.name === hint.name);
    if (hit) return { profile: hit, all, reason: hint.source };
  }
  if (all.length === 1) return { profile: all[0], all, reason: '只有一个 profile' };
  const sorted = [...all].sort((a, b) => b.lastActive - a.lastActive);
  if (sorted[0].lastActive > 0) {
    return { profile: sorted[0], all, reason: '最近活跃的 profile（没有运行中线索）' };
  }
  const fallback = all.find((p) => p.name === 'web') ?? all[0];
  return { profile: fallback, all, reason: '兜底选择' };
}

/** 自适应部署计划：CSS 补丁要不要打，理由是什么。 */
function planFor(profile, args) {
  const reasons = [];
  let css = false;
  if (args.css === 'force') {
    css = true;
    reasons.push('按 --css=force 强制打补丁');
  } else if (args.css === 'off') {
    css = false;
    reasons.push('按 --css=off 跳过');
  } else if (!profile.whale) {
    css = false;
    reasons.push('本体未安装，无处可打');
  } else if (!profile.hasClientJs) {
    css = false;
    reasons.push('该 profile 里没有 client.js（纯 host 面），CSS 补丁无处生效');
  } else if (!profile.hasClient) {
    css = false;
    reasons.push('该 profile 的 bundle 里没有客户端面（web），改 CSS 也不会被加载');
  } else {
    css = true;
    reasons.push('有客户端面且有 client.js');
  }
  return {
    css,
    // utero-sync 是 host 侧插件，任何 profile 都能用；只有"本体都没装"时先不装
    sync: profile.whale || css,
    reasons,
  };
}

/* ------------------------------------------------------- client.js 补丁 */

function readCss() {
  const file = path.join(PAYLOAD, 'mobile.css');
  if (!fs.existsSync(file)) throw new Error(`payload 缺失：${file}`);
  return fs.readFileSync(file, 'utf8').trimEnd();
}

function buildBlock(css) {
  return `${BEGIN_PREFIX} (managed by whale-utero-suite/apply.mjs — 标记区间内的手工改动会被下次 apply 覆盖) === */\n${css}\n${END_MARK}\n`;
}

/** 幂等注入：有标记就整段替换，没有就插到 prefers-reduced-motion 之前。 */
function applyCss(clientPath, css) {
  const src = fs.readFileSync(clientPath, 'utf8');
  const block = buildBlock(css);
  const beginAt = src.indexOf(BEGIN_PREFIX);
  const endAt = src.indexOf(END_MARK);

  if (beginAt >= 0 && endAt > beginAt) {
    const lineStart = src.lastIndexOf('\n', beginAt) + 1;
    const tailNewline = src.indexOf('\n', endAt + END_MARK.length);
    const lineEnd = tailNewline === -1 ? src.length : tailNewline + 1;
    return { mode: 'replace', next: src.slice(0, lineStart) + block + src.slice(lineEnd) };
  }

  const anchor = src.indexOf(INSERT_ANCHOR);
  if (anchor < 0) {
    throw new Error('client.js 里找不到插入锚点（@media prefers-reduced-motion）：插件结构可能已变，请手动检查');
  }
  const lineStart = src.lastIndexOf('\n', anchor) + 1;
  return { mode: 'insert', next: src.slice(0, lineStart) + block + src.slice(lineStart) };
}

function stripCss(clientPath) {
  const src = fs.readFileSync(clientPath, 'utf8');
  const beginAt = src.indexOf(BEGIN_PREFIX);
  const endAt = src.indexOf(END_MARK);
  if (beginAt < 0 || endAt <= beginAt) return { changed: false, next: src };
  const lineStart = src.lastIndexOf('\n', beginAt) + 1;
  const tailNewline = src.indexOf('\n', endAt + END_MARK.length);
  const lineEnd = tailNewline === -1 ? src.length : tailNewline + 1;
  return { changed: true, next: src.slice(0, lineStart) + src.slice(lineEnd) };
}

/* ---------------------------------------------------- utero-sync 插件 */

function payloadPluginDir() {
  return path.join(PAYLOAD, PLUGIN_NAME);
}

function installedPluginDir() {
  return path.join(dshHome(), 'plugins', PLUGIN_NAME);
}

function copyPayloadPlugin({ dryRun }) {
  const from = payloadPluginDir();
  const to = installedPluginDir();
  if (!fs.existsSync(from)) throw new Error(`payload 缺失：${from}`);
  if (!dryRun) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name);
      if (!fs.statSync(src).isFile()) continue;
      const dst = path.join(to, name);
      if (fs.existsSync(dst) && !fs.existsSync(dst + '.bak')) fs.copyFileSync(dst, dst + '.bak');
      fs.copyFileSync(src, dst);
    }
    fs.mkdirSync(path.join(dshHome(), PLUGIN_NAME), { recursive: true });
    const modeFile = path.join(dshHome(), PLUGIN_NAME, 'mode.json');
    if (!fs.existsSync(modeFile)) {
      fs.writeFileSync(modeFile, JSON.stringify({ mode: 'balanced' }, null, 2) + '\n');
    }
  }
  return { from, to };
}

const PATCH_BEGIN = '# utero-sync:begin (whale-utero-suite)';
const PATCH_END = '# utero-sync:end';

/** 老版 / 异构布局的注册路径：没有 dsh.profile.bundles 清单时，改 profile 的补丁层。 */
function registerViaPatchFile(profileDir, { dryRun, spec }) {
  const candidates = ['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml'].map((n) => path.join(profileDir, n));
  const file = candidates.find((item) => fs.existsSync(item));
  if (!file) return { changed: false, reason: '找不到 cordis 补丁文件，也找不到 bundles 清单' };
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(PATCH_BEGIN) || src.includes(`name: '${PLUGIN_NAME}'`) || src.includes(`name: "${PLUGIN_NAME}"`)) {
    return { changed: false, reason: '补丁文件里已有 utero-sync' };
  }
  const block = `${PATCH_BEGIN}\n- insert:\n    - id: ${PLUGIN_NAME}\n      name: '${PLUGIN_NAME}'\n${PATCH_END}\n`;
  // 空数组 `[]` 之后不能再追加列表项（YAML 会解析失败）：先把那个 token 去掉。
  // 只在这种"除了注释什么都没有"的文件上动手，正常有条目时原样保留。
  const onlyEmpty = src.split('\n').every((line) => {
    const t = line.trim();
    return t === '' || t.startsWith('#') || t === '[]' || t === '---';
  });
  const base = onlyEmpty ? src.split('\n').filter((line) => line.trim() !== '[]').join('\n') : src;
  if (!dryRun) fs.writeFileSync(file, base.replace(/\s*$/, '\n\n') + block);
  return { changed: true, reason: `已写入 ${path.basename(file)}` };
}

/** 把 utero-sync 写进 profile 的 dependencies + bundles；没有 bundles 清单就退回补丁层。 */
function registerBundle(profileDir, { dryRun }) {
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) throw new Error(`读不了 ${pkgPath}`);
  const spec = 'file:' + installedPluginDir();
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : null;
  const hasDep = pkg.dependencies?.[PLUGIN_NAME] === spec;

  // 0.1.x 早期 / 异构布局：package.json 里没有 bundle 清单，硬造一个不会被加载。
  if (bundles === null) {
    const patched = registerViaPatchFile(profileDir, { dryRun, spec });
    if (patched.changed && !dryRun && !hasDep) {
      pkg.dependencies = { ...(pkg.dependencies ?? {}), [PLUGIN_NAME]: spec };
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
    return { changed: patched.changed, spec, mode: 'patch', detail: patched.reason };
  }

  const hasBundle = bundles.includes(PLUGIN_NAME);
  if (hasDep && hasBundle) return { changed: false, spec, mode: 'bundles' };
  if (!dryRun) {
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [PLUGIN_NAME]: spec };
    pkg.dsh.profile.bundles = hasBundle ? bundles : [...bundles, PLUGIN_NAME];
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  return { changed: true, spec, mode: 'bundles' };
}

function unregisterBundle(profileDir, { dryRun }) {
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) throw new Error(`读不了 ${pkgPath}`);
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const hadDep = Boolean(pkg.dependencies?.[PLUGIN_NAME]);
  const hadBundle = bundles.includes(PLUGIN_NAME);

  // 补丁层里那一段（老式注册路径）一并清掉，两种模式都覆盖。
  let patchChanged = false;
  for (const name of ['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml']) {
    const file = path.join(profileDir, name);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const beginAt = src.indexOf(PATCH_BEGIN);
    const endAt = src.indexOf(PATCH_END);
    if (beginAt < 0 || endAt <= beginAt) continue;
    const lineStart = src.lastIndexOf('\n', beginAt) + 1;
    const tailNewline = src.indexOf('\n', endAt + PATCH_END.length);
    const lineEnd = tailNewline === -1 ? src.length : tailNewline + 1;
    if (!dryRun) fs.writeFileSync(file, src.slice(0, lineStart) + src.slice(lineEnd));
    patchChanged = true;
  }

  if (!hadDep && !hadBundle) return { changed: patchChanged };
  if (!dryRun) {
    if (hadDep) delete pkg.dependencies[PLUGIN_NAME];
    if (hadBundle) pkg.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN_NAME);
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  return { changed: true };
}

function runPnpm(profileDir, argv) {
  const result = spawnSync('pnpm', argv, { cwd: profileDir, stdio: 'inherit', env: process.env });
  if (result.error) throw new Error(`pnpm 启动失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`pnpm ${argv.join(' ')} 退出码 ${result.status}`);
}

/** 自动安装鲸鱼娘本体：pnpm add + 写 bundles（等价于 plugin_manager 的 install_bundle）。 */
function installWhale(profileDir, { dryRun }) {
  if (dryRun) return { dryRun: true };
  console.log(`安装本体     pnpm add ${WHALE_SPEC}`);
  runPnpm(profileDir, ['add', WHALE_SPEC]);
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgPath) ?? {};
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  if (!bundles.includes(WHALE_PKG)) {
    pkg.dsh = { ...(pkg.dsh ?? {}) };
    pkg.dsh.profile = { ...(pkg.dsh.profile ?? {}), bundles: [...bundles, WHALE_PKG] };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  return { installed: true };
}

/* ---------------------------------------------------------------- 命令 */

function printEnvironment(picked, args) {
  const kernel = clientKernel();
  const dsh = resolveDshVersion(args ?? {});
  const gate = versionGate(dsh);
  console.log(`宿主          ${hostKind()}   node ${process.versions.node}`);
  console.log(
    `DSH 版本      ${dsh.version ?? '未知'}（${dsh.source}）`
    + ` · 门槛 ${MIN_DSH} ${gate.ok ? '通过' : '不通过'}`,
  );
  if (!gate.ok) console.log(`              ${gate.note}；可用 --dsh-version 覆盖检测结果`);
  if (dsh.version && parseVersion(dsh.version) && cmpVersion(dsh.version, '0.3.0-0') >= 0) {
    console.log('              提示：>= 0.3.0 未经验证，若插件 API 有破坏性变更，先跑 detect 看结构再决定');
  }
  if (kernel) console.log(`客户端内核    ${kernel}`);
  console.log(`DSH_HOME      ${dshHome()}`);
  console.log(`目标 profile   ${picked.profile.name}（${picked.reason}）`);
  console.log(`  界面类型     ${picked.profile.interface}`);
  console.log(`  bundle 数    ${picked.profile.bundles.length}`);
  console.log(`  本体插件     ${picked.profile.whale ? '已安装' : '未安装'}`);
  console.log(`  手机 CSS     ${picked.profile.patched ? '已打补丁' : picked.profile.hasClientJs ? '未打补丁' : '无 client.js'}`);
  console.log(`  utero-sync  ${picked.profile.syncRegistered ? '已注册' : '未注册'}`);
  if (picked.all.length > 1) {
    console.log('其他 profile：');
    for (const other of picked.all) {
      if (other.name === picked.profile.name) continue;
      console.log(
        `  - ${other.name}: ${other.interface} · 本体${other.whale ? '有' : '无'}`
        + ` · CSS${other.patched ? '已打' : '未打'} · sync${other.syncRegistered ? '已注册' : '未注册'}`,
      );
    }
  }
}

function modeInfo() {
  const modeFile = path.join(dshHome(), PLUGIN_NAME, 'mode.json');
  if (process.env.UTERO_SYNC_MODE) return `${process.env.UTERO_SYNC_MODE}（环境变量）`;
  const raw = readJson(modeFile);
  if (raw?.mode) return raw.mode;
  return 'balanced（mode.json 不存在，按默认）';
}

function commandDetect(args) {
  const picked = pickProfile(args);
  const plan = planFor(picked.profile, args);
  console.log('== detect ==');
  printEnvironment(picked, args);
  console.log(`情景模式      ${modeInfo()}`);
  console.log(`部署计划      CSS ${plan.css ? '打' : '跳过'} · utero-sync ${plan.sync ? '装' : '跳过'}`);
  for (const reason of plan.reasons) console.log(`              - ${reason}`);
  if (!picked.profile.whale) {
    console.log('');
    console.log(`本体缺失。装法：dsh plugin --profile ${picked.profile.name} add ${WHALE_SPEC}`);
    console.log('或者带 --install-whale 跑 apply 让脚本自己装。');
  }
  console.log('');
  console.log('（detect 是只读命令，没有写任何文件。）');
}

function commandStatus(args) {
  const picked = pickProfile(args);
  console.log('== status ==');
  printEnvironment(picked, args);
  console.log(`情景模式      ${modeInfo()}`);
  console.log('');
  console.log('下一步：apply 自适应部署；改完需重启宿主。');
}

function commandApply(args) {
  const picked = pickProfile(args);
  const profile = picked.profile;
  let plan = planFor(profile, args);

  console.log(`== apply${args.dryRun ? '（dry-run，不写盘）' : ''} ==`);
  printEnvironment(picked, args);
  console.log(`部署计划      CSS ${plan.css ? '打' : '跳过'} · utero-sync ${plan.sync ? '装' : '跳过'}`);
  for (const reason of plan.reasons) console.log(`              - ${reason}`);
  console.log('');

  // 版本门槛：低于 0.1.5 直接拒绝，且不写任何文件。
  const dsh = resolveDshVersion(args);
  const gate = versionGate(dsh);
  if (!gate.ok) {
    console.log(`DSH 版本过低：${gate.note}，已放弃部署（没有写任何文件）。`);
    console.log(
      `本补丁最低支持 ${MIN_DSH}：utero-sync 只用 systemPrompt.section + tools.register，`
      + '这两个服务在 0.1.x 就已存在；客户端 CSS 补丁与版本无关。',
    );
    console.log('如果版本检测错了（比如自定义安装目录），用 --dsh-version x.y.z 覆盖。');
    process.exitCode = 2;
    return;
  }

  // 本体缺失：只有显式 --install-whale 才动手，否则给命令退出（退出码 2 = "环境不具备"）
  if (!profile.whale) {
    if (!args.installWhale) {
      console.log(`本体未安装，已放弃部署（不会写任何文件）。`);
      console.log(`装法一：dsh plugin --profile ${profile.name} add ${WHALE_SPEC}`);
      console.log(`装法二：node apply.mjs apply --install-whale（脚本自动装）`);
      process.exitCode = 2;
      return;
    }
    installWhale(profile.dir, { dryRun: args.dryRun });
    // 装完重新画像，后面按真实环境继续
    Object.assign(profile, profileInfo(profile.name));
    plan = planFor(profile, args);
    if (!args.dryRun) console.log('');
  }

  if (plan.css) {
    const clientPath = clientPathOf(profile.dir);
    if (!fs.existsSync(clientPath)) {
      // --css=force 硬要打，但这个 profile 里根本没有 client.js：说清楚，别抛 ENOENT
      console.log('手机 CSS       跳过：--css=force 要求打补丁，但该 profile 没有 client.js（纯 host 面）');
      plan.css = false;
    } else {
      const result = applyCss(clientPath, readCss());
      console.log(`手机 CSS       ${result.mode === 'replace' ? '替换已有标记块' : '首次插入'}`);
      if (!args.dryRun) {
        const backup = clientPath + '.utero-suite.bak';
        if (!fs.existsSync(backup)) fs.copyFileSync(clientPath, backup);
        fs.writeFileSync(clientPath, result.next);
        console.log(`  已写入       ${clientPath}`);
        console.log(`  部署前备份   ${backup}`);
      }
    }
  } else {
    console.log('手机 CSS       跳过（见上方理由：这个环境不消费 client.js，打了也不会被加载）');
  }

  if (plan.sync) {
    const copied = copyPayloadPlugin({ dryRun: args.dryRun });
    console.log(`utero-sync     ${args.dryRun ? '将复制到' : '已复制到'} ${copied.to}`);
    const reg = registerBundle(profile.dir, { dryRun: args.dryRun });
    const modeLabel = reg.mode === 'patch' ? '补丁层' : 'bundles';
    console.log(`注册 bundle    ${reg.changed ? (args.dryRun ? '将写入' : '已写入') : '已是最新'}（${modeLabel}）`);
    if (reg.detail && !reg.changed) console.log(`              ${reg.detail}`);
  }

  if (args.install && !args.dryRun && (plan.css || plan.sync || args.installWhale)) {
    console.log('pnpm install   ...');
    runPnpm(profile.dir, ['install']);
  } else if (!args.install) {
    console.log('pnpm install   已跳过（--no-install）');
  }

  console.log('');
  if (plan.css || plan.sync) {
    console.log('完成。**重启一次宿主**才生效（客户端 bundle 与 host 插件都在启动时装配）。');
    console.log('情景强度：' + path.join(dshHome(), PLUGIN_NAME, 'mode.json') + ' 里改 quiet|balanced|scene，3 秒内生效。');
  } else {
    console.log('没有需要部署的东西（见上方理由）。');
  }
}

function commandRevert(args) {
  const picked = pickProfile(args);
  const profile = picked.profile;
  console.log(`== revert${args.dryRun ? '（dry-run）' : ''} ==`);
  printEnvironment(picked, args);

  const clientPath = clientPathOf(profile.dir);
  if (fs.existsSync(clientPath)) {
    const stripped = stripCss(clientPath);
    if (stripped.changed) {
      if (!args.dryRun) fs.writeFileSync(clientPath, stripped.next);
      console.log('手机 CSS       已移除标记块');
    } else {
      console.log('手机 CSS       没有标记块，跳过');
    }
    const backup = clientPath + '.utero-suite.bak';
    if (fs.existsSync(backup)) {
      console.log(`  提示：部署前备份仍在 ${backup}，要彻底回到部署前就手动 cp 回去`);
    }
  } else {
    console.log('client.js      不存在，跳过');
  }

  const un = unregisterBundle(profile.dir, { dryRun: args.dryRun });
  console.log(`注销 bundle     ${un.changed ? (args.dryRun ? '将移除' : '已移除') : '本来就没注册'}`);

  if (args.install && !args.dryRun) {
    console.log('pnpm install   ...');
    runPnpm(profile.dir, ['install']);
  }

  console.log('');
  console.log('完成。utero-sync 的插件目录与 mode.json 保留在 ' + installedPluginDir() + '，要彻底删除可手动 rm -rf。');
}

function commandHelp() {
  console.log(`whale-utero-suite —— 鲸鱼娘插件手机适配 + 对话状态同步 的通用补丁

  node apply.mjs detect                     环境检测（只读，不写任何东西）
  node apply.mjs status                     部署状态（只读）
  node apply.mjs apply                      自适应部署（按环境决定打不打 CSS）
  node apply.mjs apply --dry-run            只打印，不写盘
  node apply.mjs apply --install-whale      本体缺失时自动安装
  node apply.mjs apply --no-install         跳过 pnpm install
  node apply.mjs apply --css=force|off      覆盖自适应的 CSS 决策
  node apply.mjs apply --profile desktop    指定 profile（默认自动探测）
  node apply.mjs apply --dsh-home <path>    指定 DSH_HOME（桌面版与 CLI 的目录不同）
  node apply.mjs apply --dsh-version x.y.z  覆盖版本检测（门槛：>= ${MIN_DSH}）
  node apply.mjs revert                     还原 client.js 并摘掉 utero-sync

自动探测顺序：--profile → DSH_PROFILE/DSH_ACTIVE_PROFILE → 运行中 dsh 进程的 --profile
             → 只有一个 profile → 最近活跃 → 兜底 web

支持的端：浏览器端（web profile）、Electron 桌面版（profiles/desktop，DSH_HOME 可能是
          %APPDATA%\\dsh-desktop\\harness 或 ~/.config/dsh-desktop/harness）、Android DSHBox。
          纯 host 面（acp/headless/sdk）不打 CSS，只装 utero-sync。

最低版本：DSH ${MIN_DSH}。低于它直接拒绝，且不写任何文件（退出码 2）。
          版本来源：--dsh-version → DSH_VERSION → 安装目录里的 package.json。

部署规则：有客户端面（web/desktop）才打 CSS；utero-sync 是 host 插件，任何 profile 都装。
          本体缺失且没给 --install-whale 时，脚本不写任何文件，退出码 2。

环境变量：DSH_HOME、DSH_PROFILE、DSH_VERSION、UTERO_SYNC_MODE、UTERO_SYNC_OFF、WHALE_UTERO_STATE`);
}

/* ---------------------------------------------------------------- 入口 */

function main() {
  const args = parseArgs(process.argv.slice(2));
  // --dsh-home 要在任何 dshHome() 调用之前生效（桌面版与 CLI 的 DSH_HOME 不是同一个目录）
  if (args.dshHome) setDshHome(args.dshHome);
  if (args.command === 'help') return commandHelp();
  if (args.command === 'detect') return commandDetect(args);
  if (args.command === 'status') return commandStatus(args);
  if (args.command === 'apply') return commandApply(args);
  if (args.command === 'revert') return commandRevert(args);
  throw new Error(`未知命令：${args.command}`);
}

try {
  main();
} catch (error) {
  console.error('失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
