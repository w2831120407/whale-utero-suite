# whale-utero-suite

「鲸鱼娘生理扩展」（`dsh-whale-utero`）+ 对话状态同步（`utero-sync`）的**通用补丁套件**：
一个可重复执行的脚本，把散落在两处的改动收成一份可分发、可回滚的东西。

```
whale-utero-suite/
├── apply.mjs                 # 唯一入口：status / apply / revert
├── README.md
└── payload/
    ├── mobile.css            # 要注入 client.js 的手机端 CSS（≤820px）
    └── utero-sync/           # 插件本体（apply 时复制到 $DSH_HOME/plugins/utero-sync）
        ├── package.json
        ├── cordis.patch.yml
        └── index.js
```

## 它解决什么

`dsh-whale-utero` 是从 GitHub 装的第三方包，每次 `dsh plugin add` 升级都会**整份覆盖**
`node_modules/dsh-whale-utero/`。所以任何直接改在包内的东西都会丢。这个脚本把两件改动
做成可重放的补丁：

1. **手机端适配**：给 `client.js` 注入一段 `@media (max-width:820px)` 的 CSS——
   页面本体可纵向滚动、内层不再嵌套滚动、导航/标签/动作按钮横向滑动、卡片不再
   `overflow:hidden` 裁内容、滚动条统一成可见细条。
   注入区用 `utero-mobile-patch:begin/end` 标记包住，**重复执行只会替换标记区间**，
   不会叠加。

2. **对话同步**：落盘并注册 `utero-sync` 插件。它只读鲸鱼娘每 5s 原子落盘的
   `data/state.json`，通过 `systemPrompt.section()` 把「精简状态 + 情景协议」注入每个
   会话，并注册 `utero_scene` 工具供模型在闲聊时按需取情景素材。

**情景协议**（注入内容的一部分，决定"不打扰任务"）：

- 任务优先：写代码 / 跑命令 / 改文件 / 排查报错 / 技术回答时，不许表演状态，
  最多在结尾带半句语气词；
- 只有三种时机允许情景：用户明确要、用户问起状态、本轮纯闲聊；
- 允许时一次 1~2 句，不铺陈、不复述数字。

## 支持的端与最低版本

| 端 | profile | 判定 | 部署 |
|---|---|---|---|
| 浏览器端（CLI `dsh web`） | `web` | bundles 含 `@deepseek-ai/dsh-web-app` | CSS + utero-sync |
| Electron 桌面版 | `desktop`（保留 profile） | profile 名 `desktop` 且有客户端面 | CSS + utero-sync |
| Android DSHBox | 任意 | 内核 `-android` / env 含 `com.dshbox.app` | 同上（按 profile 判断） |
| 纯 host 面 | `acp` / `headless` / `sdk` | 只有 acp/headless/sdk bundle | 只装 utero-sync |

桌面版的 `DSH_HOME` 与 CLI **不是同一个目录**，脚本按顺序探测：

1. `--dsh-home <path>`
2. 环境变量 `DSH_HOME`
3. `%APPDATA%\dsh-desktop\harness`（Windows）
4. `~/Library/Application Support/dsh-desktop/harness`（macOS）
5. `~/.config/dsh-desktop/harness`（Linux）
6. `~/.dsh`

判定依据是「那个目录下有 `profiles/`」，不是猜。

**最低 DSH 版本：`0.1.5`。** 比较用 `0.1.5-0` 作下界，所以 `0.1.5-rc.2` 这类预发布也算通过
（DSH 的发行版几乎全是 `-rc.x`；写死 `0.1.5` 会把 `0.1.5-rc.2` 误判成不满足）。
低于门槛时 `apply` 直接拒绝并**不写任何文件**，退出码 2；版本来源优先级：
`--dsh-version` → `DSH_VERSION` → 安装目录里的 `dsh`/`dsh-base` package.json。

`>= 0.3.0` 会打一行「未经验证」提示但不阻塞。

老式布局兼容：如果 profile 的 `package.json` 里**没有** `dsh.profile.bundles` 清单
（早期 0.1.x 或异构发行版），脚本不再硬造这个字段，而是改 profile 的
`cordis.patch.yml` / `cordis.yml`，插入一段带 `# utero-sync:begin/end` 标记的
`- insert:`；`revert` 会把该区间整段删掉。文件里只有注释和空数组 `[]` 时，会先把
`[]` 去掉再追加（否则 YAML 会解析失败）。

## 环境检测与自适应

部署前先跑一遍检测（`detect` 只读，不写任何文件）：

```bash
node apply.mjs detect
```

它会报出四件事，并据此给出部署计划：

| 检测项 | 依据 |
|---|---|
| 宿主 | 内核 release 的 `-android`、`process.platform`、env 里的 `MOZ_ANDROID_*` / `PROOT_*` / `com.dshbox.app` |
| 客户端内核 | `MOZ_ANDROID_LIBDIR` → geckoview；其余 Android 环境 → system-webview/未知 |
| DSH 版本 | `--dsh-version` → `DSH_VERSION` → `$DSH_RUNTIME` / `/opt/dshapp/runtime` / 各 profile 的 `@deepseek-ai/dsh`、`dsh-base` |
| 目标 profile | `--profile` → `DSH_PROFILE`/`DSH_ACTIVE_PROFILE` → 运行中 dsh 进程的 `--profile` → 唯一 profile → 最近活跃 → 兜底 |
| 该 profile 的界面 | bundle 里有 `@deepseek-ai/dsh-web-app` = 有客户端面（`desktop` profile 记为 desktop）；只有 `dsh-acp-app`/`dsh-headless`/`dsh-sdk-app` = 纯 host 面 |

自适应规则：

| 环境 | 手机 CSS | utero-sync |
|---|---|---|
| 有客户端面（web）+ 有 client.js | 打 | 装 |
| 纯 host 面（acp / headless / sdk），无 client.js | 跳过（打了也没人加载） | 装（host 插件，任何 profile 都能用） |
| 本体未安装 | 跳过 | 跳过，**并且不写任何文件**，退出码 2 |

`--css=force` / `--css=off` 可以覆盖这个决策；`force` 碰上没有 client.js 的 profile 时会
明确提示后跳过，而不是抛 ENOENT。

宿主是 Android 上的 DSHBox（proot）时，宿主一行会显示 `android-dshbox（proot）`——
这不是靠 `process.platform` 猜的，proot 里 node 看到的是 linux。

## 用法

也可以直接用 `./install.sh`（默认 `detect`）或 `./install.sh apply`，等价于 `node apply.mjs <命令>`。

```bash
# 1) 看环境与现状（两个都只读）
node apply.mjs detect
node apply.mjs status

# 2) 自适应部署（自动判断要不要打 CSS、装到哪个 profile）
node apply.mjs apply

# 只预览不写盘
node apply.mjs apply --dry-run

# 本体没装时，让脚本自己装（默认只提示命令）
node apply.mjs apply --install-whale

# 3) 重启一次宿主（客户端 bundle 与 host 插件都在启动时装配）
```

其他参数：

| 参数 | 作用 |
|---|---|
| `--profile <name>` | 指定 profile；不给就自动探测（含 `desktop`） |
| `--dsh-home <path>` | 指定 DSH_HOME（桌面版与 CLI 的目录不同） |
| `--dsh-version x.y.z` | 覆盖版本检测；低于 `0.1.5` 会被拒绝 |
| `--install-whale` | 本体缺失时自动 `pnpm add` 并写 bundles |
| `--css=force` / `--css=off` | 覆盖自适应的 CSS 决策 |
| `--no-install` | 跳过 `pnpm install`（自己手动装） |
| `--dry-run` | 只打印，不写任何文件 |

环境变量：`DSH_HOME`、`DSH_PROFILE`、`DSH_VERSION`、`UTERO_SYNC_MODE`、
`UTERO_SYNC_OFF=1`、`WHALE_UTERO_STATE`（手动指定 state.json）、
`DSH_RUNTIME`（自定义运行时目录，用于版本检测）。

退出码：`0` 正常；`1` 脚本自身失败（锚点缺失、payload 缺失等）；
`2` 环境不具备（本体未安装且没给 `--install-whale`，此时没有任何写操作）。

## 情景强度

`$DSH_HOME/utero-sync/mode.json`：

```json
{ "mode": "balanced" }
```

- `quiet`：只注入数字，明令禁止提及或表演——写代码时一个字都不露
- `balanced`（默认）：任务轮次零表演；闲聊 / 被问起时才 1~2 句
- `scene`：任务轮次允许首尾各一句，闲聊放开到 2~3 句

改完约 3 秒生效（插件内有缓存），不用重启。也可以用 `UTERO_SYNC_MODE` 覆盖。

## 插件升级之后

升级鲸鱼娘插件会覆盖 `client.js`，但**不会**影响 `utero-sync`（它在独立目录）。
重跑一次即可恢复手机适配：

```bash
node apply.mjs apply
```

`apply` 找不到标记会插到 `@media (prefers-reduced-motion:reduce)` 之前；插件结构若有大改
导致锚点消失，脚本会直接报错并指出缺哪个锚点，不会写坏文件。

## 卸载

```bash
node apply.mjs revert
```

- 从 `client.js` 里移除标记区间（不动其它内容）
- 从 profile 的 `dependencies` / `dsh.profile.bundles` 摘掉 `utero-sync`
- 保留 `$DSH_HOME/plugins/utero-sync/` 与 `mode.json`（要彻底删就 `rm -rf` 那两个）

`client.js.utero-suite.bak` 是**首次 apply 前**的版本，需要完全回到打补丁前就手动 `cp` 回去。

## 改哪里

- 改 CSS → 改 `payload/mobile.css`，再 `apply`
- 改插件逻辑 / 文案 / 档位阈值 → 改 `payload/utero-sync/index.js`，再 `apply`

⚠️ 直接改 `$DSH_HOME/plugins/utero-sync/` 里的文件会在下次 `apply` 时被 `payload` 覆盖
（脚本会先留 `.bak`）。

## 前提

- Node.js ≥ 20（本机 24.x）
- profile 里已安装鲸鱼娘插件：
  `dsh plugin --profile web add github:TianhuMoMo/DSH-shengli`
- `pnpm` 在 PATH 里（除非用 `--no-install`）
