# dsh-stack

一个 DSH 插件，做三件事：

1. **「DS Stack 模式」agent preset** —— 在官方 `ptc` 预设上加一层：工作纪律人设 + 自动触发规则。
2. **8 个常驻 ds-* 技能** —— 作为技能 provider 注册（rank 600），散装副本缺失时兜底。
3. **守卫** —— 把两条最容易漂的规则变成机制：改完没验证、同一修法连错两次。
4. **一套可搬走的安装器** —— 复制目录 + 跑一条命令，重启即生效；不写注册表，不改系统。

## 它每轮注入什么

`presets/persona.txt` 的全文会作为 system prompt 前缀注入每一轮。现在是两层：

| 层 | 条数 | 内容 | 谁执行 |
|---|---|---|---|
| 每轮必守 | 10 条（覆盖 15 个技能）| ds-mode / ds-verify-loop / ds-tdd / ds-unstick / ds-blueprint / ds-explain / ds-unslop / ds-plan-loop / ds-context-reset / ds-ledger / ds-blast-radius / ds-principles / ds-lessons / ds-sharpen / grill | 模型，每轮都在眼前 |
| 按任务触发 | 4 行索引 | ds-ship / ds-ready / ds-pr / ds-pr-comments / ds-watch-pr / ds-jury / ds-review-loop / ds-swarm / ds-best-of-n / ds-adopt / ds-revive / ds-catchup / ds-design / ds-design-audit / ds-help | 模型，命中即做；可机械检查的交给守卫 |

29 个 ds-* 技能全部在这两层里出现过，没有只在磁盘上躺着的。人设从 512 字变成 1041 字（每轮多约 350 token）。
## 结构

| 文件 | 作用 |
|---|---|
| [cordis.patch.yml](cordis.patch.yml) | bundle 层：由 [scripts/build-bundle.mjs](scripts/build-bundle.mjs) 从官方 **ptc** 预设生成，插入 `preset-ds-stack` |
| [lib/index.js](lib/index.js) | 技能 provider：`inject: ["skills"]`，注册 `assets/skills/*/SKILL.md`，rank 600；装上守卫 |
| [lib/guard.js](lib/guard.js) | 守卫：`agent/pre-step` 前置提醒 + `agent/turn-stopping` 兜底 |
| [test/guard.test.mjs](test/guard.test.mjs) | 守卫的 26 个用例（`npm test`） |
| [scripts/guard-replay.mjs](scripts/guard-replay.mjs) | 按步回放真实会话，量每条规则会响几次（`npm run replay`） |
| [assets/skills/](assets/skills) | 8 个常驻技能 |
| [presets/persona.txt](presets/persona.txt) | 模式人设 + 自动触发规则，每轮注入 |
| [skills.manifest.json](skills.manifest.json) | 8 条 sha256 + 21 个不常驻项 + 优先级阶梯 |
| [RESIDENT.md](RESIDENT.md) | 人读的常驻清单与触发规则表 |
| [scripts/install.mjs](scripts/install.mjs) | 注册成 profile bundle（Windows 用 junction，其它平台复制目录） |
| [scripts/build-bundle.mjs](scripts/build-bundle.mjs) | 生成 bundle，带逐字节反向校验；基底可切：`DS_STACK_BASE=standard` |

## 安装 / 卸载

```bash
node scripts/install.mjs --check                 # 只报告，不动任何文件
node scripts/install.mjs --apply  --profile <名字>  # 注册到某个 profile
node scripts/install.mjs --remove --profile <名字>  # 撤销
```

`--apply` 写三处（各留 `.bak-<时间戳>`）：profile 的 `package.json` 依赖、`dsh.profile.bundles`、`node_modules/dsh-stack` 链接（Windows 建 junction，其它平台复制目录）。重启 DSH，在模式选择里选「DS Stack 模式」。

## 搬到另一台机器 / 手机

整个目录是自包含的，没有绝对路径依赖（`cordis.patch.yml` 已生成好，不需要重新构建）：

1. 把 `dsh-stack/` 整个目录复制过去，放在任意位置。
2. `node <目录>/scripts/install.mjs --apply --profile <profile 名>`
3. 重启 DSH，选「DS Stack 模式」。

前置条件：`grill` 技能可选（没有它时规则会退化成「一次一问、能查的自己查」）；`ds-*` 散装副本不是必需的，常驻那 8 个由本包自带。

**目标机器自己跑 DSH 内核（例如手机）时，多一步**：先 `node scripts/build-bundle.mjs` 用**那台机器**的基底预设重新生成 `cordis.patch.yml`（脚本会自己找 DSH 安装根，找不到就打印候选并提示用 `DSH_APP_ROOT` 指过去），再装。电脑上生成的 patch 直接搬过去，版本不一致时可能引用不存在的插件行。

工作区不共享：`@路径` 解析的是目标机器自己的工作区，要引用别处的文件，先复制进去。

## 守卫：规则不靠自觉

persona 的规则是散文，长会话里会漂。守卫在两个点上看本回合的会话日志：

| 触发点 | 什么时候 | 做什么 |
|---|---|---|
| `agent/pre-step` | 模型每一次开口之前 | 命中规则 → 在这一步的消息末尾追加一条 checkpoint |
| `agent/turn-stopping` | 模型仍要收尾 | 同样的判定 → `steer` 一句，让回合再走一步 |

五条规则：改了非文档文件却没有成功的检查（ds-verify-loop）；连续 2 次工具调用失败（ds-unstick）；本回合真推送 / 开了 PR（ds-blast-radius + ds-pr，临时仓库探针不算）；一轮成功改了 6 个以上代码文件（ds-plan-loop，文档和配置成批写不算）；会话很长却没写过 PROGRESS.md（ds-context-reset，每会话一次，走独立通道，不占回合预算）。前四条每回合最多 2 条。

先量再改：`npm run replay` 会把一个真实会话按步回放，输出每条规则会响几次；`node scripts/guard-replay.mjs --all` 跑全部历史会话。改动规则前先看这个数。

两种工具形态都认：直接调用的 `write`/`edit`/`bash`，以及 PTC 模式下 `run_code` 程序里的内层调用（`tool/ptc-dispatch`，自带 `isError`，用 `rootCallId` 找回回合）。`run_code` 自己的外层结果不算证据——它只是整段程序的汇总。

边界：每回合最多 2 条（pre-step 1 + 轮末 1）；只改 `.md/.txt/.rst` 等文档时豁免；守卫自己抛错只 `warn` 一次，绝不打断回合。

为什么不是只在轮末：`dsh-agent-loop` 先跑 `step()`（助手消息已推送），再跑 `turn-stopping`；轮末只能补一句，收不回已经发出去的结论。

## 覆盖关系

```
project .dsh 100 < project .agents 200 < custom 300 < ~/.dsh/skills 400 < ~/.agents/skills 500 < 本插件 600
```

数字小的赢，本地同名散装副本优先，插件只保证「缺了也还在」。想反过来压本地，把 `lib/index.js` 的 `RANK` 改到 500 以下。

## 边界

- 常驻技能正文口径：`description` ≤180 字符、单卷正文 ≤2000 字符。
- 不常驻的 21 个仍在 `~/.agents/skills`，需要时自动匹配加载；本插件不负责它们的存在性。
- `~/.agents/skills` 里的同名散装副本 rank 500，压过本包 600：本包改了正文、散装不动，运行时读到的还是旧副本。两边要一起改。
- DSH 升级后基底预设变了，要重跑 `node scripts/build-bundle.mjs` 再重启（需要本机有官方 `ptc.patch.yml`）。
- 技能正文是上游原文；示例路径要换成本机真实路径。
