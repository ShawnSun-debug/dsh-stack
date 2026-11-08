# CHANGELOG

## 0.8.1 — 2026-11-08

- 电脑端不受影响：安装器只在 `$DSH_HOME/dsh-go` 已存在时才写界面配置；没有 dsh-go 的机器直接跳过，连目录都不建。
- 桌面加载器只读 `dsh.bundle.patch` 与 `dsh.bundle.platforms`（不写即全平台），`dsh.go` 是未知字段，被忽略。

## 0.8.0 — 2026-11-08

- 带 dsh-go 界面：插件自带 `ui/go.json`（4 颗胶囊 + 4 张新对话建议卡），安装时自动并进 `$DSH_HOME/dsh-go/ui.json`，卸载时只拿走自己那几项。
- 合并幂等，用户自己加的胶囊/建议卡原样保留（按动作而不是标签识别）。
- `package.json` 声明适配：`dsh.go.ui` + `minAppVersion: 1.0.13`。
- 胶囊从 5 颗减回 4 颗：5 颗会把输入框那一行撑到出现遮挡。
- 用例 40 → 45（新增 lib/go-ui.mjs 的合并/移除用例）。

## 0.7.2 — 2026-11-08

- 修打包：`files` 里缺 `presets/`，tarball 里没有 `presets/persona.txt`，拿到包的人无法重建 bundle、也改不了人设。
- 新增 `test/package.test.mjs`：断言 files 覆盖运行与重建需要的文件，且 files 里没有不存在的条目。
- `npm test` 改成 `node --test test/*.test.mjs`（Node 24 不接受目录导入）。
- 用例 38 → 40。

## 0.7.1 — 2026-11-08

- 修 0.7.0 的错位：路由读的是会话里上一句用户消息（当前这句在 pre-step 时还没写进会话），导致「现在几点了」被当成上一轮的任务判成 high。改成优先读本步认领的消息。
- 闲聊档按你的要求从 low 改成 off。
- 用例 37 → 38。

## 0.7.0 — 2026-11-08

- 按意图路由推理强度：闲聊/问状态 → low，修 bug·重构·设计·评审·交付·计划 → max，其余 → high。
- 只改 effort，不插「模型已切换」提示（内核对此类切换不产生 notice）。
- 你在界面上手动切过强度后，本会话不再自动改。
- 已知限制：内核在 pre-step 之前就读了 selection，所以改动从下一步生效；一问一答的单步回合会慢一拍。
- 用例 34 → 37。

## 0.6.1 — 2026-11-08

- 修 context 规则误报：在脚本里落盘的 PROGRESS.md（heredoc / `node -e` / `cat >`）以前不算写过，长会话里会重复提醒。
- 用例 33 → 34。

## 0.6.0 — 2026-11-08

- 意图路由：说人话就按流程走，不用报技能名。回合第一步看用户原话，「解释一下 / 发出去 / 审一下 / 到哪了 / 接手 / 做个页面 / 出个计划 / 修一下 / 验证一下」各自路由到对应技能，注入一条一两句的流程提示。
- 不带斜杠的技能名也认：`ds-tdd`、`用 ds-ship 做完` 都能触发。
- 路由走独立通道，不占守卫的回合预算，也不会重复提醒同一回合。
- 用例 32 → 33。

## 0.5.1 — 2026-11-08

- 提醒给具体命令：按被改文件的类型给 `node --check x.js` / `npx tsc --noEmit` / `python3 -m py_compile x.py` 等；推不出来才退回通用说法。
- 守卫写日志：命中一条就追加一行 JSON 到 `$DSH_HOME/dsh-stack/guard.log`（时间、会话、回合、规则、界面、文件），超过 200KB 留最后 500 行。
- 提醒文案压短（127 → 约 70 字）。
- 用例 26 → 29。

## 0.5.0 — 2026-11-08

- 29 个 ds-* 技能全部进预设：10 条每轮必守（覆盖 15 个）+ 4 行任务索引（覆盖 14 个）。
- 守卫上线：evidence / unstick / delivery / scope / context 五条规则，pre-step 前置提醒 + 轮末 steer 兜底，每回合最多 2 条。
- 回放工具 `scripts/guard-replay.mjs`：按 step 逐步回放真实会话，量每条规则会不会响；`--all` 覆盖全部历史会话。
- 规则收紧：delivery 排除临时仓库探针，scope 只数代码文件且门槛 6 个；context 走独立通道，不占回合预算。
- 文档：新增 [docs/mapping.md](docs/mapping.md)（29 条映射与守卫覆盖表）。

## 0.4.0 — 2026-11-07

- 从 `dsh-ds-stack` 改名为 `dsh-stack`。
- 常驻技能 baseline（8 个，rank 600）+ 一条命令的安装/卸载。
- `cordis.patch.yml` 由 `scripts/build-bundle.mjs` 从官方 ptc 预设生成，带逐字节反向校验。
