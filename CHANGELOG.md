# CHANGELOG

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
