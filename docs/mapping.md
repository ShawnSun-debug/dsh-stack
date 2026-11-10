# 29 个 ds-* 技能落到哪里

这个模式的全部内容就是这张表：每个技能要么变成每轮必守的一句话，要么变成按任务触发的索引，
再要么被守卫做成机械检查。没有第四个去处，也没有「留在磁盘上等模型想起来」的技能。

## 一、每轮必守（9 条 + 1 行 ledger + 1 个常驻块，覆盖 15 个技能）

写在 `presets/persona.txt`，每轮随 system prompt 注入。

| 技能 | 压成的那句话 | 靠什么生效 |
|---|---|---|
| ds-mode | 开工先复述目标与最小改动，先读后改 | 人设 |
| ds-verify-loop | 改完跑最窄的真检查，证据与结论同条 | 人设 + 守卫 evidence |
| ds-tdd | 修 bug 先写一条会失败的测试 | 人设 |
| ds-unstick | 同一命令两轮不绿就换前提 | 人设 + 守卫 unstick |
| ds-blueprint | 结构未定先定类型 / 签名 / 模块边界 | 人设 |
| ds-explain | 汇报三段：是什么 → 改了什么/怎么跑 → 为什么长这样 | 人设 |
| ds-unslop | 短句、具体、去 AI 腔 | 人设 |
| ds-plan-loop | 多文件先出编号计划 + 每步验收 | 人设 + 守卫 scope |
| ds-context-reset | PROGRESS.md 五节、每验一步更新、换上下文交接与新会话开场白（整段常驻）| 人设常驻块 + 守卫 context |
| ds-ledger | 长跑用一行一决定的 TSV | 人设 |
| ds-blast-radius | 交付前算 diff 之外的影响面并真跑证明 | 人设 + 守卫 delivery |
| ds-principles | 结构决策点出用了哪条原则 | 人设 |
| ds-lessons | 被纠正后把教训变成结构 | 人设 |
| ds-sharpen | 任务模糊或高风险先重述 | 人设 |
| grill | 要做什么先问透（非 ds-*，但同一层） | 人设 |

## 二、按任务触发（4 行索引，覆盖 14 个技能）

同一份 persona 的后半段，命中即做，不用用户点名。

| 技能 | 触发 |
|---|---|
| ds-ship / ds-ready | 「发出去」—— 到合并 / 停在 PR ready |
| ds-pr / ds-pr-comments / ds-watch-pr | 开 PR、写评论、盯 PR |
| ds-jury / ds-review-loop | 要独立评委 / 要回环评审 |
| ds-swarm / ds-best-of-n | 宽而浅的活 / 一次可能赌错 |
| ds-adopt / ds-revive | 接手别人的 / 复活旧 PR |
| ds-catchup | 问我「到哪了」 |
| ds-design / ds-design-audit | 前端：定方向 / 按证据打分 |
| ds-help | 不知道用哪个技能 |

## 三、被守卫机械化的部分（5 条规则）

| 规则 | 命中条件 | 提醒里点名的技能 | 预算 |
|---|---|---|---|
| evidence | 改了非文档文件，之后没有成功的 bash/pwsh | ds-verify-loop | 每回合 2 条 |
| unstick | 连续 2 次工具调用失败 | ds-unstick | 同上 |
| delivery | 本回合真推送 / 开 PR（临时仓库探针不算） | ds-blast-radius + ds-pr | 同上 |
| scope | 一轮成功改了 6 个以上代码文件（文档不算） | ds-plan-loop | 同上 |
| context | 会话 ≥600 事件、turn ≥6、没写过 PROGRESS.md | ds-context-reset | 每会话 1 条，独立通道 |

守卫挂在 `agent/pre-step`（模型开口前）与 `agent/turn-stopping`（兜底），实现见 [lib/guard.js](../lib/guard.js)。

## 四、推理强度路由

回合第一步按用户原话选 effort：闲聊 off、难任务 max、其余 high；只改 effort，不产生模型切换提示；手动切过就停手。

## 五、意图路由（说人话就触发）

守卫在回合第一步读用户原话，命中就把对应流程的一句提示塞进这一步；走独立通道，不占预算。
认的说法见 [README](../README.md#不用报技能名意图路由)，认不出来就不猜。

## 六、优先级与覆盖关系

- 技能副本：project .dsh 100 < project .agents 200 < custom 300 < ~/.dsh/skills 400 < ~/.agents/skills 500 < 本包 600；数字小的赢。
- 本包只保证「散装副本被删或换机器后，这 8 个仍然在」；正文口径以散装副本为准。
- 规则层面没有优先级之争：人设的 10 条每轮都在，守卫只补机械可查的部分，两者不互相覆盖。

## 七、怎么验证这张表没漂

```bash
npm test                                   # 26 个用例：判定、预算、异常兜底
npm run replay                             # 单个会话回放
node scripts/guard-replay.mjs --all        # 全部历史会话
node scripts/install.mjs --verify --profile web
```

基线（21 个会话 / 71 回合）：unstick 1、evidence 9、delivery 7、scope 18、context 3。
