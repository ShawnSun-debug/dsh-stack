# 交付清单 —— dsh-stack

一个 DSH 内核插件。装进任何 profile，选「DS Stack 模式」就生效。

---

## 一、插件做什么

| # | 做的事 | 落在哪 |
|---|---|---|
| 1 | 往 system prompt 每轮注入一段工作纪律 + 自动触发规则 | `presets/persona.txt` → 由 `cordis.patch.yml` 注入 preset |
| 2 | 注册 8 个 ds-* 技能（rank 600，散装副本 rank 500 优先，本包兜底） | `lib/index.js` + `assets/skills/` |
| 3 | 提供一条命令的安装/卸载（Windows junction，其它平台复制目录） | `scripts/install.mjs` |
| 4 | 守卫：改完没验证 / 同一修法连错两次，在 pre-step 提醒、轮末 steer 兜底 | `lib/guard.js`（`npm test`） |

它**不**做的事：不改 DSH 源码、不写注册表、不替用户改 `~/.agents/skills`、不自动安装别的插件。

## 二、每轮注入的规则（29 个技能全部进来）

第一层「每轮必守」10 条：复述与最小改动、先写失败测试、跑真检查、失败两次换前提、结构先定形状、证据与结论同条、汇报三段式、去 AI 腔、多文件先出计划、长任务 PROGRESS.md。

第二层「按任务触发」4 行索引：发出去（ship/ready/pr/pr-comments/watch-pr）、多人看（jury/review-loop）、并行与赌错（swarm/best-of-n）、接手与状态（adopt/revive/catchup）。

守卫再把能机械检查的部分接住：缺证据、连续失败、真推送后、代码文件改太多（6 个以上，文档不算）。规则改动前先用 scripts/guard-replay.mjs 量一遍历史会话（70 回合的基线：evidence 9、unstick 1、delivery 7、scope 18）。
## 三、它提供的技能（8 个常驻）

| 技能 | 做什么 | 什么时候出现 |
|---|---|---|
| `ds-mode` | 默认工作风格：复述、先读后改、一步一验、短报告 | 每个任务开场 |
| `ds-plan-loop` | 编号计划 + 每步验收 + 一次批判 | 多文件、多步骤 |
| `ds-verify-loop` | 真检查 → 读真错误 → 修根因 → 重跑 | 修 bug 时自动接在 ds-tdd 后 |
| `ds-principles` | 设计/调试/验证/委派的紧凑原则 | 结构决策 |
| `ds-tdd` | 先写会失败的测试 | 修 bug 时自动触发 |
| `ds-unstick` | 两次失败就点破假设、直接测 | 同一失败第二次 |
| `ds-blast-radius` | 找 diff 之外会炸的地方并真跑证明 | 高风险改动 |
| `ds-context-reset` | 状态存 PROGRESS.md，换上下文续跑 | 长任务、上下文过半 |

其余 21 个 ds-* 技能不随包，仍在 `~/.agents/skills`，任务命中时按 description 自动匹配。

## 四、它调用什么

| 调用对象 | 用途 | 谁需要它 |
|---|---|---|
| DSH `skills` 服务 | `inject: ["skills"]`，注册 provider | 插件本体，必须 |
| Skill 工具（`skill`） | 命中时加载 SKILL.md 正文 | 运行时 |
| `grill` 技能 | 结构改动规则的前半（问透） | 推荐但不必须：没有它时规则要求「一次一问、能查的自己查」后直接进 `ds-blueprint` |
| `git` / `gh` | ds-pr、ds-ship、ds-ready 等 PR 流程 | 只有跑 PR 流程时 |
| `python3` | ds-watch-pr 的 `scripts/watch_pr.py` | 只有盯 PR 时 |
| `subagent` 能力 | ds-jury / ds-swarm 开并行 worker | 只有用这两条时 |

## 五、装法

### 本机（Windows，已装）

```powershell
cd D:\Phoneix\plugins\dsh-stack
node scripts/install.mjs --check                 # 报 resident skills: 8
node scripts/install.mjs --apply --profile superagent
```

### 另一台机器 / 手机上的 DSH 内核

整个目录自包含，`cordis.patch.yml` 已生成好，**不需要**重新构建：

1. 复制整个 `dsh-stack/` 目录过去（任意路径）。
2. 目标机器上装好 `grill` 技能（规则点名了它）。
3. `node <目录>/scripts/install.mjs --check` → 应报 `resident skills: 8`
4. `node <目录>/scripts/install.mjs --apply --profile <profile 名>`
5. `node <目录>/scripts/install.mjs --verify --profile <profile 名>` → 应全 PASS、最后一行 `verify: ok`
6. 重启 DSH → 模式选择里选「DS Stack 模式」。

没有符号链接权限的平台（部分移动端）会自动退化成复制目录，安装器会打印用的是哪一档。

### 目标机器自己跑 DSH 内核时（手机）

先重新生成 bundle，再装：

```bash
node scripts/build-bundle.mjs        # 用那台机器的基底预设生成；找不到根会打印候选和 DSH_APP_ROOT 用法
node scripts/build-bundle.mjs --check
```

原因：`cordis.patch.yml` 是从**生成它那台机器**的官方 ptc 预设推导出来的；两边 DSH 版本不同时，它引用的插件行可能不存在。

另外，`@路径` 解析的是那台机器自己的工作区，跨机器的文件要先复制过去。

### 目标机器上没有 node 时（手工三步）

1. 把整个 `dsh-stack/` 目录复制到 `<profile>/node_modules/dsh-stack`。
2. 编辑 `<profile>/package.json`：
   - `dependencies` 里加 `"dsh-stack": "file:<复制过去的绝对路径>"`（用 link: 也行，取决于包管理器）；
   - `dsh.profile.bundles` 数组里加一项 `"dsh-stack"`。
3. 重启 DSH，模式选择里应出现「DS Stack 模式」。

## 六、本机验证记录（2026-11-05，插件版本 0.4.0）

| 检查 | 命令 | 结果 |
|---|---|---|
| 技能数 | `node scripts/install.mjs --check` | `resident skills: 8` |
| 技能 provider 真跑 | 直接调 `lib/index.js` 的 `apply` + `list()` | 8 条，rank 600，source `bundled`，描述齐全，`get()` 返回去掉 frontmatter 的正文 |
| bundle 生成 | `node scripts/build-bundle.mjs` | round-trip ok，persona 12 行写入 `cordis.patch.yml` |
| 安装器语法 | `node --check scripts/install.mjs` | ok |
| 规则是否真的进了 bundle | 对 `cordis.patch.yml` 做 5 条字符串断言 | 全部命中 |
| 装后核对（目标机器用） | `--verify --profile demo`（临时 profile，装前/装后/卸后各跑一次） | 装前 3 条 FAIL、装后全 PASS、卸后回到 FAIL，退出码 1/0/1 |
| bundle 是合法 YAML | 用 `yaml` 包解析 `cordis.patch.yml` | 顶层数组；`preset-ds-stack` 的 `id=ds-stack`、`name=DS Stack 模式`；24 个 plugin 行；`skill-ds-stack` 行在；persona 12 行、4 条规则。`!!js` 标签报警是基底预设自带的，DSH 加载器认识它 |
| 干净 profile 安装 | 临时 profile + 独立 `USERPROFILE` 跑 `--apply` | 依赖写成 `link:`、bundle 注册、junction 建成、profile 留 `.bak-` |
| 干净 profile 卸载 | 同一 profile 跑 `--remove` | 依赖、bundle、链接全部回滚 |
| 无符号链接的平台 | `DS_STACK_NO_SYMLINK=1` 强制退化 | 打印 `symlink failed (NO_SYMLINK), copied the folder instead`，复制 10 个条目，`--remove` 能删掉复制目录 |

未验证：在手机上的实际安装与「DS Stack 模式」是否出现在模式列表 —— 本机没有可用的远端 host（`remote_list_hosts` 返回空），也没法在这里跑一次目标设备。

## 七、已知限制

1. 常驻副本与 `~/.agents/skills` 的散装副本是两份文件，改一边不会同步另一边。
2. `grill` 不在包内（它是入口技能，正文还依赖 `~/.agents/grill-parts/` 里的成员，装不全反而误导），规则已写成没有它也能退化执行。
3. `ds-blueprint` 的正文第一步写着「讲不清就先跑 ds-explain」，与本模式「不用 ds-explain」的规则冲突；本包没改技能正文，以规则为准。
4. DSH 升级后官方基底预设若变，需要在本机重跑 `build-bundle.mjs` 并重启。
