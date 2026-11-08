# 当前常驻技能清单

> 先分清两件事：**常驻 8 个**指本包随包分发、在散装副本缺失时兜底的那 8 个技能；
> 而「DS Stack 模式」的规则引用的是全部 29 个 ds-*（10 条必守 + 4 行任务索引）——
> 那部分写在 presets/persona.txt，不依赖这些技能文件存在。全量映射见 docs/mapping.md。

更新：2026-11-05　来源：`assets/skills`

**8 个**（29 → 16 → 8 → 9 → 8）。ds-explain 已移出常驻（模式规则规定不使用它）；ds-context-reset 因为在长时间 ds-ship 流程里要靠 PROGRESS.md 换上下文续跑而留下。

| # | 技能 | 一句话 |
|---|---|---|
| 1 | `ds-blast-radius` | 找 diff 之外会炸的地方，并真跑证明关键安全事实 |
| 2 | `ds-context-reset` | 状态存 PROGRESS.md，换新上下文凭文件续上 |
| 3 | `ds-mode` | 常驻工作风格：复述任务、先读后改、小步验证、短报告 |
| 4 | `ds-plan-loop` | 编号计划 + 每步验收 + 一次批判，再逐步执行 |
| 5 | `ds-principles` | 设计/调试/验证/委派的紧凑原则，带触发条件 |
| 6 | `ds-tdd` | 先写会失败的测试，再最小修复（修 bug 时自动触发） |
| 7 | `ds-unstick` | 两次失败就点明假设、直接测、列三种别的办法 |
| 8 | `ds-verify-loop` | 编辑 → 真检查 → 读真错误 → 修根因 → 重跑（修 bug 时自动接在 ds-tdd 后面） |

**不常驻（21 个）**：`ds-adopt`、`ds-best-of-n`、`ds-blueprint`、`ds-catchup`、`ds-design`、`ds-design-audit`、`ds-explain`、`ds-help`、`ds-jury`、`ds-ledger`、`ds-lessons`、`ds-pr`、`ds-pr-comments`、`ds-ready`、`ds-review-loop`、`ds-revive`、`ds-sharpen`、`ds-ship`、`ds-swarm`、`ds-unslop`、`ds-watch-pr`

## 自动触发规则（写在 presets/persona.txt，每轮注入）

| 命中 | 动作 |
|---|---|
| 修 bug | `ds-tdd` 先写一条会失败的测试 → `ds-verify-loop` 跑到绿；同一命令两轮不绿转 `ds-unstick` |
| 结构改动（新模块/新接口/签名未定） | `grill` 问透（没有 grill 就一次一问、能查的自己查）→ `ds-blueprint` 定形状；两条成对，不单独用 |
| 需要审视 | `ds-jury`；`ds-review-loop`、`ds-lessons` 只在用户点名时用 |
| 任何时候 | 不使用 `ds-explain` |

## 进常驻改变了什么、没改变什么

- **改变了**：`~/.agents/skills` 被清空、换机器、重装之后，这 8 个照常出现。
- **没改变**：每轮 token 不变（每个技能一行 description，原来就在目录里）；命中率不变；运行时读到的正文也不变 —— rank 500 的散装副本始终压过本包的 600，本包只在散装缺失时接管。

## 维护约定

散装副本和本包是两份独立文件。**改了散装不同步这里，换机器后就是旧版。** 同步检查：

```powershell
node scripts/install.mjs --check
```

应答应为 `resident skills: 8`。逐文件摘要见 `skills.manifest.json` 的 `sha256`。
