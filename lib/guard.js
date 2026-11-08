/**
 * ds-stack guard —— 把技能里能被机械检查的纪律，挪到发生的那个点上。
 *
 * 规则原文在 presets/persona.txt。散文在长会话里会漂，这里在回合的两个钩子上看会话日志：
 *
 *   1. agent/pre-step —— 模型每一次开口之前，把命中规则的检查点追加到这一步的消息里。
 *   2. agent/turn-stopping —— 兜底：模型还是要收尾，就 steer 一句让回合再走一步。
 *
 * 为什么不是只在轮末：dsh-agent-loop 先跑 step（助手消息已推送），再跑 turn-stopping，
 * 轮末只能补一句，收不回已经发出去的结论。
 *
 * 四条规则（每回合每条最多一次，总共最多 2 条）：
 *   evidence —— 改了非文档文件，之后没有成功的检查（ds-verify-loop）
 *   unstick  —— 连续 2 次工具调用失败（ds-unstick）
 *   delivery —— 本回合推送了 / 开了 PR（ds-blast-radius + ds-pr）
 *   scope    —— 本回合成功改过 5 个以上不同文件（ds-plan-loop）
 *
 * 守卫自己出错只 warn 一次，绝不打断回合；文档改动豁免。
 *
 * @module dsh-stack/guard
 */

export const SOURCE_KIND = "ds-stack-guard";

const Q = String.fromCharCode(96);
const MUTATION_TOOLS = new Set(["write", "edit"]);
const CHECK_TOOLS = new Set(["bash", "pwsh"]);
const DOC_SUFFIXES = [".md", ".mdx", ".txt", ".rst", ".adoc"];
const FAIL_STREAK = 2;
// 一轮动 6 个以上「代码文件」才算扩散；文档/配置成批写是常态，不算。
const SCOPE_LIMIT = 6;
const MAX_NOTICES = 2;
const PUSH_PATTERN = /\bgit\s+push\b|\bgh\s+pr\s+(?:create|merge)\b/i;
// 临时仓库探针（mktemp + git init --bare + push）不是交付，别提醒。
const TEMP_REPO_PATTERN = /\bmktemp\b|git\s+init\b|--bare\b/i;
const NON_CODE_PATTERN = /\.(md|mdx|txt|rst|adoc|json|ya?ml|csv|tsv)$/i;

/** 会话里已记录的事件；不同版本可能只有 events 或 snapshotEvents。 */
export function readEvents(session) {
  const events =
    typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : session?.events;
  return Array.isArray(events) ? events : [];
}

/** 参数里读一个字段（真值可能是 JSON 字符串，也可能是对象）。 */
function argumentOf(raw, key) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  return parsed[key];
}

/** 工具调用参数里被改到的路径（只用常见字段，解析失败就当没写）。 */
function targetsOf(raw) {
  const found = [];
  for (const key of ["file_path", "filePath", "path", "file"]) {
    const value = argumentOf(raw, key);
    if (typeof value === "string" && value.length > 0) found.push(value);
  }
  return [...new Set(found)];
}

function commandOf(raw) {
  const value = argumentOf(raw, "command");
  return typeof value === "string" ? value : "";
}

/** 全是被改的文档时豁免：没有任何命令能证明一篇 md 改对了。 */
export function onlyDocumentation(paths) {
  if (paths.length === 0) return false;
  return paths.every((candidate) => {
    const lower = String(candidate).toLowerCase();
    return DOC_SUFFIXES.some((suffix) => lower.endsWith(suffix));
  });
}

/**
 * 把一回合的事件压成守卫要的几个事实。
 * @param events 会话事件数组
 * @param turn 回合号
 */
export function turnOutcomes(events, turn) {
  const names = new Map();
  const targets = new Map();
  const turns = new Map();
  const outcomes = [];

  for (const event of events) {
    const data = event?.data;
    if (data === undefined || data === null) continue;

    // 外层工具调用：记下名字、回合和被改路径，供内层 dispatch 与结果配对。
    if (event.type === "tool/call") {
      if (typeof data.callId !== "string") continue;
      names.set(data.callId, data.name ?? "unknown");
      turns.set(data.callId, data.turn);
      targets.set(data.callId, targetsOf(data.arguments));
      continue;
    }

    // PTC 模式：run_code 里跑的才是真正的 bash/edit，内层调用自带 isError，
    // 通过 rootCallId 找回它属于哪个回合。
    if (event.type === "tool/ptc-dispatch") {
      if (turns.get(data.rootCallId) !== turn) continue;
      outcomes.push({
        name: data.name ?? "unknown",
        isError: data.isError === true,
        targets: targetsOf(data.arguments),
        command: commandOf(data.arguments),
      });
      continue;
    }

    if (event.type !== "tool/result") continue;
    const message = data.message;
    const callId = message?.toolCallId;
    const owner = data.turn ?? turns.get(callId);
    if (owner !== turn) continue;
    // run_code 的外层结果是整段程序的汇总，内层 dispatch 已经计过一次。
    if (names.get(callId) === "run_code") continue;
    outcomes.push({
      name: names.get(callId) ?? "unknown",
      isError: message?.isError === true,
      targets: targets.get(callId) ?? [],
      command: "",
    });
  }

  return outcomes;
}

/**
 * 把一回合的事件压成守卫要的几个事实。
 * @param events 会话事件数组
 * @param turn 回合号
 */
export function analyzeTurn(events, turn) {
  const outcomes = turnOutcomes(events, turn);

  let lastMutation = -1;
  let lastCheck = -1;
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    if (outcome.isError) continue;
    if (MUTATION_TOOLS.has(outcome.name)) lastMutation = index;
    else if (CHECK_TOOLS.has(outcome.name)) lastCheck = index;
  }

  let failStreak = 0;
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    if (!outcomes[index].isError) break;
    failStreak += 1;
  }

  const mutatedFiles = [];
  const mutatedAll = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    if (outcome.isError || !MUTATION_TOOLS.has(outcome.name)) continue;
    mutatedAll.push(...outcome.targets);
    if (index > lastCheck) mutatedFiles.push(...outcome.targets);
  }

  const pushes = outcomes.filter(
    (outcome) =>
      outcome.name === "bash" &&
      !outcome.isError &&
      PUSH_PATTERN.test(outcome.command) &&
      !TEMP_REPO_PATTERN.test(outcome.command),
  ).length;

  return {
    evidenceMissing: lastMutation >= 0 && lastCheck < lastMutation,
    failStreak,
    mutatedFiles: [...new Set(mutatedFiles)],
    mutatedAll: [...new Set(mutatedAll)],
    mutatedCode: [...new Set(mutatedAll)].filter((file) => !NON_CODE_PATTERN.test(file)),
    pushes,
    activity: outcomes.length,
  };
}

function where(files) {
  if (files.length === 0) return "本回合改过文件";
  const shown = files
    .slice(0, 3)
    .map((file) => Q + file + Q)
    .join("、");
  return "本回合改了 " + shown + (files.length > 3 ? " 等文件" : "");
}

/** 模型开口前的提醒：还有一步可以补验证。 */
export function evidenceNotice(files) {
  return (
    "DS Stack 检查点（自动）：" +
    where(files) +
    "，之后没有跑过成功的检查。先跑一条能证明它的命令（测试、构建或直接执行），把结果和结论放在同一条消息里；确实跑不了，就用一句话说明卡在哪、哪些没验证，再给结论。"
  );
}

/** 轮末兜底：已经说到一半了，只能要求它现在补。 */
export function evidenceSteer(files) {
  return (
    "DS Stack 检查点（自动）：你正要收尾，但 " +
    where(files) +
    "没有成功的检查证明它。现在跑最小的一条验证命令再给结论；跑不了就直接写「未验证」和原因。这条只提醒一次，不会拦住你。"
  );
}

export function unstickNotice(failStreak) {
  return (
    "DS Stack 检查点（自动）：最近 " +
    failStreak +
    " 次工具调用都失败了。不要再来第三个变体：说出这几次共用的假设，直接测它（ds-unstick），再换路子并说明换了什么。"
  );
}

export function deliveryNotice() {
  return (
    "DS Stack 检查点（自动）：这一轮已经推送或开了 PR。汇报与 PR 描述要写清三件事：影响面（diff 之外会坏什么，ds-blast-radius）、验证证据（跑过的命令与结果，ds-verify-loop）、回滚方式；标题和描述按十秒可读写（ds-pr）。"
  );
}

export function scopeNotice(count) {
  return (
    "DS Stack 检查点（自动）：这一轮已经成功改了 " +
    count +
    " 个代码文件。先写编号计划和每步验收（ds-plan-loop），再继续动；如果这是无意的扩散，先停下说清楚。"
  );
}

/**
 * 四条规则的优先级，守卫和 scripts/guard-replay.mjs 共用一份，避免两边漂移。
 * @returns 规则名，或 "none"
 */
export function decideRule(analysis) {
  if (analysis.failStreak >= FAIL_STREAK) return "unstick";
  if (analysis.evidenceMissing && !onlyDocumentation(analysis.mutatedFiles)) return "evidence";
  if (analysis.pushes > 0) return "delivery";
  if (analysis.mutatedCode.length >= SCOPE_LIMIT) return "scope";
  return "none";
}

function checkpoint(id, text) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: SOURCE_KIND },
  };
}

/**
 * 装上守卫。
 * @param ctx cordis 上下文（DS Stack 预设里挂载，天然只在这个模式生效）
 */
export function installGuard(ctx) {
  // 拿不到事件总线就安静退出：技能照常提供，不因为守卫装不上而拖垮模式。
  if (typeof ctx?.on !== "function") return;
  const spent = new Map();
  const SPENT_LIMIT = 500;
  let warned = false;

  const warnOnce = (message) => {
    if (warned) return;
    warned = true;
    try {
      ctx.logger?.warn?.(message);
    } catch {
      /* 打日志失败也不该拖垮回合 */
    }
  };

  // 预算：pre-step 每回合最多 1 条，轮末最多再补 1 条，总共不超过 MAX_NOTICES。
  // 看一眼没提醒不占名额。
  const usedOf = (key) => spent.get(key) ?? 0;
  const remember = (key) => {
    spent.set(key, usedOf(key) + 1);
    if (spent.size > SPENT_LIMIT) spent.delete(spent.keys().next().value);
  };

  const decide = (agent, turn) => {
    const analysis = analyzeTurn(readEvents(agent?.session), turn);
    return { rule: decideRule(analysis), analysis };
  };

  const noticeFor = (verdict, atTurnEnd) => {
    switch (verdict.rule) {
      case "unstick":
        return unstickNotice(verdict.analysis.failStreak);
      case "evidence":
        return atTurnEnd
          ? evidenceSteer(verdict.analysis.mutatedFiles)
          : evidenceNotice(verdict.analysis.mutatedFiles);
      case "delivery":
        return deliveryNotice();
      case "scope":
        return scopeNotice(verdict.analysis.mutatedCode.length);
      default:
        return "";
    }
  };

  // 1) 模型开口之前：把检查点挂在 messages 末尾，答案还没生成。
  ctx.on("agent/pre-step", async ({ agent, step, turn, signal }, next) => {
    const decision = await next();
    try {
      if (decision?.kind !== "enter" || signal?.aborted) return decision;
      const verdict = decide(agent, turn);
      if (verdict.rule === "none") return decision;
      const key = agent.session.id + ":" + turn;
      if (usedOf(key) >= 1) return decision;
      remember(key);
      return {
        ...decision,
        messages: [
          ...decision.messages,
          checkpoint(
            SOURCE_KIND + "-" + agent.session.id + "-" + turn + "-" + step,
            noticeFor(verdict, false),
          ),
        ],
      };
    } catch (error) {
      warnOnce("ds-stack guard: pre-step check failed: " + String((error && error.message) || error));
      return decision;
    }
  });

  // 2) 轮末兜底：模型还是要收尾，就 steer 一句让回合再走一步。
  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    try {
      if (typeof agent?.steer !== "function" || agent.session === undefined) return;
      const verdict = decide(agent, turn);
      if (verdict.rule === "none") return;
      const key = agent.session.id + ":" + turn;
      if (usedOf(key) >= MAX_NOTICES) return;
      remember(key);
      agent.steer(
        checkpoint(SOURCE_KIND + "-" + agent.session.id + "-" + turn + "-stop", noticeFor(verdict, true)),
      );
    } catch (error) {
      warnOnce("ds-stack guard: turn-stopping check failed: " + String((error && error.message) || error));
    }
  });
}
