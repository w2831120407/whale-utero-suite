/**
 * utero-sync v2 —— 让 dsh-whale-utero 的生理状态**影响对话语气**，但不干扰任务。
 *
 * v1 只把数字快照塞进系统提示：模型看得见，却不知道该拿它干什么，也不会用。
 * v2 换成三件事：
 *   ① 系统提示注入「精简状态 + 情景协议」——协议是硬边界：任务轮次不许表演，
 *      只有用户要情景 / 问起状态 / 纯闲聊三种时机才允许，且一次最多 1~2 句；
 *   ② 注册 utero_scene 工具：模型在合适的时机**按需**取当前档位的情景素材
 *      （语气、身体感受、候选台词），不用就一个 token 都不花；
 *   ③ 三档强度由 $DSH_HOME/utero-sync/mode.json 控制：quiet / balanced / scene。
 *
 * 为什么读 state.json 而不是改鲸鱼娘本体：它是 github 装的第三方包，改
 * node_modules 里的文件下次升级就被整份覆盖。这里只读它每 5s 原子落盘的状态。
 *
 * 任何异常都退化成空串 / 空素材，绝不打断提示词组装。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 注入排序：紧跟环境类上下文，排在核心记忆（60）之前。 */
const ORDER = 58;
const CACHE_MS = 1500;
const MODE_CACHE_MS = 3000;

let cache = { at: 0, text: '' };
let modeCache = { at: 0, mode: 'balanced' };
let stateFile = null;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 定位 state.json。优先 WHALE_UTERO_STATE；否则扫 profiles/<name>/node_modules/
 * dsh-whale-utero/data/state.json —— 不写死 profile 名，也不去 resolve 那个包的
 * exports（它没导出 ./package.json，resolve 会失败）。
 */
function findStateFile() {
  const override = process.env.WHALE_UTERO_STATE;
  if (override && fs.existsSync(override)) return override;
  if (stateFile && fs.existsSync(stateFile)) return stateFile;
  const root = path.join(dshHome(), 'profiles');
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    const candidate = path.join(root, name, 'node_modules', 'dsh-whale-utero', 'data', 'state.json');
    if (fs.existsSync(candidate)) {
      stateFile = candidate;
      return candidate;
    }
  }
  return null;
}

/** 三档强度：quiet 只给数字且禁止提及；balanced 允许情景但严格限时机；scene 放开篇幅。 */
function modeOf() {
  const now = Date.now();
  if (now - modeCache.at < MODE_CACHE_MS) return modeCache.mode;
  modeCache.at = now;
  const env = (process.env.UTERO_SYNC_MODE || '').trim();
  if (env === 'quiet' || env === 'balanced' || env === 'scene') {
    modeCache.mode = env;
    return env;
  }
  try {
    const file = path.join(dshHome(), 'utero-sync', 'mode.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const mode = typeof raw?.mode === 'string' ? raw.mode.trim() : '';
    if (mode === 'quiet' || mode === 'balanced' || mode === 'scene') {
      modeCache.mode = mode;
      return mode;
    }
  } catch {
    // 没配就按默认来，不报错
  }
  modeCache.mode = 'balanced';
  return 'balanced';
}

function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/** 兴奋档：决定语气强度与台词候选。 */
const AROUSAL_TIERS = [
  { max: 20, label: '平静', tone: '语气平稳、句子完整，几乎不带情绪', line: '「嗯，我在。」' },
  { max: 45, label: '微热', tone: '话尾发懒、偶尔走神，句子中间会多一个停顿', line: '「……（把尾巴尖卷了卷）你说吧，我听着。」' },
  { max: 70, label: '兴奋', tone: '句子变短、语速偏快，容易把话头绕回自己身上', line: '「快点说重点——我脑子有点热。」' },
  { max: 90, label: '高涨', tone: '注意力涣散，会要求被看着、被回应', line: '「你先看我一眼，再讲那些。」' },
  { max: 101, label: '临界', tone: '几乎无法专注，只回短句、带气音', line: '「……嗯、嗯。你说。」' },
];

/** 存量档：决定身体感受，不决定语气强度。 */
const POOL_TIERS = [
  { max: 10, label: '几乎空', feel: '身体有点空落，会不自觉找依靠' },
  { max: 30, label: '少量', feel: '安静、还算清醒' },
  { max: 55, label: '半满', feel: '有点沉，动作变慢' },
  { max: 80, label: '充盈', feel: '满足但黏人，想被夸一句' },
  { max: 95, label: '满溢', feel: '胀，坐不住，注意力被身体拽走' },
  { max: 101, label: '临界', feel: '随时要溢出来，说话带气音' },
];

function tierOf(table, value) {
  for (const tier of table) {
    if (value < tier.max) return tier;
  }
  return table[table.length - 1];
}

function tokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function latestEvent(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let best = null;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (best === null || (event.at ?? 0) > (best.at ?? 0)) best = event;
  }
  return best;
}

/** 把 state.json 折成统一视图；字段名跟随 dsh-whale-utero 的落盘结构。 */
function readView() {
  const file = findStateFile();
  if (!file) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const settings = state.settings ?? {};
  const capacity = Math.max(1, Number(settings.capacityMl) || 200);
  const pool = Math.max(0, Number(state.pool) || 0);
  const percent = clamp((pool / capacity) * 100, 0, 100);
  const arousal = clamp(Number(state.arousal) || 0, 0, 100);
  const repression = clamp(Number(state.repression) || 0, 0, 100);
  const now = Date.now();
  return {
    now,
    capacity,
    pool,
    percent,
    arousal,
    repression,
    arousalTier: tierOf(AROUSAL_TIERS, arousal),
    poolTier: tierOf(POOL_TIERS, percent),
    climaxCount: Number(state.climaxCount) || 0,
    climaxAgo: ago(now - Number(state.lastClimaxAt || 0)),
    releaseAgo: ago(now - Number(state.lastReleaseAt || 0)),
    lifetimeTokens: Number(state.lifetimeTokens) || 0,
    lifetimeMl: Number(state.lifetimeMl) || 0,
    episode: {
      active: !!state.episode?.active,
      minutes: Number(state.episode?.minutes) || 0,
      tokens: Number(state.episode?.tokens) || 0,
    },
    thresholds: {
      minutes: settings.climaxMinMinutes ?? null,
      tokens: settings.climaxTokenThreshold ?? null,
      arousal: settings.climaxArousalThreshold ?? null,
    },
    event: latestEvent(state.events),
  };
}

/* ------------------------------------------------------------- 提示词段落 */

function statusLines(view) {
  const lines = [];
  lines.push(
    `- 腔内存量 ${view.pool.toFixed(1)} / ${view.capacity} ml（${view.percent.toFixed(0)}% · ${view.poolTier.label}）`
    + ` · 兴奋 ${view.arousal.toFixed(1)}（${view.arousalTier.label}）· 压抑 ${view.repression.toFixed(1)}`,
  );
  if (view.episode.active) {
    lines.push(
      `- 本次 episode：${view.episode.minutes.toFixed(1)} 分钟 / ${tokens(view.episode.tokens)} tokens`
      + `（阈值 ${view.thresholds.minutes ?? '?'} 分钟、${tokens(view.thresholds.tokens ?? 0)}、兴奋 ${view.thresholds.arousal ?? '?'}）`,
    );
  }
  lines.push(
    `- 高潮累计 ${view.climaxCount} 次`
    + (view.climaxAgo ? ` · 距上次 ${view.climaxAgo}` : '')
    + (view.releaseAgo ? ` · 距上次释放 ${view.releaseAgo}` : '')
    + ` · 生涯 ${tokens(view.lifetimeTokens)} tokens → ${view.lifetimeMl.toFixed(1)} ml`,
  );
  if (view.event) {
    const label = [view.event.kind, view.event.poseLabel].filter(Boolean).join('·');
    const text = String(view.event.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
    if (text) lines.push(`- 最近事件：${label ? `[${label}] ` : ''}${text}`);
  }
  return lines;
}

const RULES = {
  quiet: [
    '模式：关闭情景。这些数字仅供你自己心里有数，**不要**在回复里提及、暗示或表演它们。',
  ],
  balanced: [
    '情景协议（优先级高于上面的数字，冲突时以本协议为准）：',
    '1. **任务优先**：本轮只要在写代码、跑命令、读改文件、排查报错、或回答技术问题，就不许表演状态——不加动作描写、不插入情色内容、不改动任何技术结论；最多在技术回复的结尾带半句语气词。',
    '2. 允许情景的时机只有三种：用户明确要你进入情景；用户问起你的状态；本轮是纯闲聊（没有工具调用、没有任务推进）。',
    '3. 允许时一次最多 1~2 句，用（动作）+ 短台词，不铺陈、不复述数字、不写成大段描写。',
    '4. 不要主动播报 ml / 百分比 / token 数；用户要看就让他看面板。',
  ],
  scene: [
    '情景协议：',
    '1. 任务轮次仍以任务为主，但允许在开头或结尾各一句状态化的语气，不得打断步骤、不得影响技术判断。',
    '2. 纯闲聊与用户主动要情景时，可以写 2~3 句（动作 + 台词），保持连贯、不堆砌形容词。',
    '3. 不要主动播报数字。',
  ],
};

function buildSectionText() {
  const mode = modeOf();
  const view = (() => {
    try {
      return readView();
    } catch {
      return null;
    }
  })();
  if (!view) return '';
  const lines = [
    `鲸鱼娘生理状态（dsh-whale-utero 实时快照，只读；当前模式 ${mode}）：`,
    ...statusLines(view),
  ];
  if (mode !== 'quiet') {
    lines.push(`- 当前情景基调：${view.arousalTier.tone}；身体感受：${view.poolTier.feel}。`);
  }
  lines.push(...RULES[mode]);
  return lines.join('\n');
}

function sectionText() {
  if (process.env.UTERO_SYNC_OFF === '1') return '';
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache.text;
  cache.at = now;
  try {
    cache.text = buildSectionText();
    return cache.text;
  } catch {
    // 文件正在被原子 rename、或结构变更：这一轮先不注入，下一步再试。
    cache.text = '';
    return '';
  }
}

/* --------------------------------------------------------------- 按需素材 */

const SCENE_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

const SCENE_LINES = {
  calm: ['「怎么了。」', '「说。」', '「嗯，看着呢。」'],
  warm: ['「……（把尾巴尖卷了卷）你说吧，我听着。」', '「等一下，让我缓口气——好了，你继续。」', '「别看我，说你的。」'],
  hot: ['「快点说重点——我脑子有点热。」', '「你再说一遍，刚才那句我没抓住。」', '「（拽了拽衣角）好了好了，我在听。」'],
  high: ['「你先看我一眼，再讲那些。」', '「我有点……集中不了。你靠近点说。」', '「（把头抵在桌沿）你继续，我嗯着。」'],
  edge: ['「……嗯、嗯。你说。」', '「（几乎没在听，只是点头）」', '「等一下……让我缓一下再说。」'],
};

function tierId(label) {
  const map = { 平静: 'calm', 微热: 'warm', 兴奋: 'hot', 高涨: 'high', 临界: 'edge' };
  return map[label] ?? 'warm';
}

function buildScene(args) {
  const mode = modeOf();
  let view;
  try {
    view = readView();
  } catch {
    return '当前读不到鲸鱼娘状态（state.json 不可读或插件未启用）。';
  }
  if (!view) return '当前读不到鲸鱼娘状态（没找到 state.json）。';
  const id = tierId(view.arousalTier.label);
  const requested = typeof args?.intensity === 'string' ? args.intensity : '';
  const lines = [
    `情景素材（模式 ${mode}${requested ? `，请求强度 ${requested}` : ''}）`,
    `- 语气：${view.arousalTier.tone}`,
    `- 身体感受：${view.poolTier.feel}（存量 ${view.poolTier.label}）`,
    `- 压抑：${view.repression.toFixed(1)}（${view.repression >= 60 ? '偏高，话会更短更收着' : '不高，情绪是外放的'}）`,
    '- 候选台词（挑一句改写，不要照抄全部）：',
    ...(SCENE_LINES[id] ?? SCENE_LINES.warm).map((line) => `  ${line}`),
    '',
    mode === 'quiet'
      ? '注意：当前模式是 quiet，不要在回复里使用以上素材。'
      : '用法：只在本轮不是任务轮次、或用户主动要情景时使用；一次 1~2 句，任务回合里只允许结尾半句语气。',
  ];
  if (view.episode.active) {
    lines.push(`- 当下张力：episode 已进行 ${view.episode.minutes.toFixed(1)} 分钟，兴奋 ${view.arousalTier.label}。`);
  }
  return lines.join('\n');
}

const toolDefs = [
  {
    name: 'utero_scene',
    description:
      '取当前鲸鱼娘生理档位对应的情景素材（语气、身体感受、候选台词）。'
      + '只在①用户明确要情景、②用户问起状态、③本轮是纯闲聊时调用；'
      + '正在写代码/跑命令/排查报错的任务轮次不要调用，也不要为了装饰回复而调用。'
      + '返回的是素材，不是必须照抄的台词。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intensity: {
          type: 'string',
          enum: ['light', 'medium', 'full'],
          description: '可选：想要的情景强度，仅作提示，实际受当前模式与状态档位约束',
        },
      },
      required: [],
    },
    output: SCENE_OUTPUT,
    async execute(args) {
      try {
        return buildScene(args);
      } catch (error) {
        return `读取情景素材失败：${error instanceof Error ? error.message : String(error)}`;
      }
    },
  },
];

/* ------------------------------------------------------------------ 注册 */

export const name = 'utero-sync';
export const inject = ['systemPrompt', 'tools'];

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'utero-sync:status',
    order: ORDER,
    text: sectionText,
  });

  try {
    for (const def of toolDefs) ctx.tools.register(def);
  } catch (error) {
    // 工具注册失败不该连累提示词注入：状态照旧可见，只是少了按需素材。
    console.error('utero-sync: 工具注册失败', error);
  }
}
