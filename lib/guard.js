/**
 * engineer guard —— 把技能里能被机械检查的纪律，挪到发生的那个点上。
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

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SOURCE_KIND = "engineer-guard";

const Q = String.fromCharCode(96);
const MUTATION_TOOLS = new Set(["write", "edit"]);
const CHECK_TOOLS = new Set(["bash", "pwsh"]);
const DOC_SUFFIXES = [".md", ".mdx", ".txt", ".rst", ".adoc"];
const FAIL_STREAK = 2;
// 一轮动 6 个以上「代码文件」才算扩散；文档/配置成批写是常态，不算。
const SCOPE_LIMIT = 6;
const MAX_NOTICES = 2;
// 长会话提醒：事件数过 600、turn ≥ 6，且整个会话没碰过 PROGRESS.md。
const CONTEXT_MIN_EVENTS = 600;
const CONTEXT_MIN_TURN = 6;
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

/** 按文件类型给出最窄的验证命令；推不出来就返回 null（提醒退回通用说法）。 */
const CHECK_BY_EXT = [
  [/\.(mjs|cjs|js)$/i, (file) => "node --check " + file],
  [/\.(ts|tsx)$/i, () => "npx tsc --noEmit"],
  [/\.py$/i, (file) => "python3 -m py_compile " + file],
  [/\.go$/i, () => "go build ./..."],
  [/\.rs$/i, () => "cargo check"],
  [/package\.json$/i, () => "npm test"],
];

export function suggestCheck(files) {
  for (const file of files) {
    for (const [pattern, make] of CHECK_BY_EXT) {
      if (pattern.test(file)) return make(file);
    }
  }
  return null;
}

/** 守卫自己的日志：一行一条，放在 $DSH_HOME/dsh-engineer-mode/guard.log，超 200KB 留最后 500 行。 */
const LOG_MAX_BYTES = 200 * 1024;
export function guardLogPath() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "dsh-engineer-mode", "guard.log");
}

function appendGuardLog(entry) {
  try {
    const file = guardLogPath();
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > LOG_MAX_BYTES) {
        const kept = readFileSync(file, "utf8").trim().split("\n").slice(-500);
        writeFileSync(file, kept.join("\n") + "\n");
      }
    } catch {
      /* 文件还不存在，或读不动：直接追加 */
    }
    appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    /* 写日志失败不该影响回合 */
  }
}

function where(files) {
  if (files.length === 0) return "本回合改过文件";
  const shown = files
    .slice(0, 3)
    .map((file) => Q + file + Q)
    .join("、");
  return "本回合改了 " + shown + (files.length > 3 ? " 等文件" : "");
}

/** 模型开口前的提醒：还有一步可以补验证，能给出具体命令就给。 */
export function evidenceNotice(files) {
  const suggestion = suggestCheck(files);
  const ask = suggestion
    ? "先跑 " + Q + suggestion + Q + "（或更贴近它的测试），把结果和结论放一起。"
    : "先跑一条能证明它的命令（测试、构建或直接执行），把结果和结论放一起。";
  return "Engineer 检查点（自动）：" + where(files) + "，还没验证。" + ask + "跑不了就写「未验证」和原因。";
}

/** 轮末兜底：已经说到一半了，只能要求它现在补。 */
export function evidenceSteer(files) {
  const suggestion = suggestCheck(files);
  const ask = suggestion ? "现在跑 " + Q + suggestion + Q + " 再给结论。" : "现在跑最小的一条验证命令再给结论。";
  return (
    "Engineer 检查点（自动）：你正要收尾，但 " +
    where(files) +
    "没有成功的检查。" +
    ask +
    "跑不了就直接写「未验证」和原因。这条只提醒一次，不会拦住你。"
  );
}

export function unstickNotice(failStreak) {
  return (
    "Engineer 检查点（自动）：最近 " +
    failStreak +
    " 次工具调用都失败了。不要再来第三个变体：说出这几次共用的假设，直接测它（ds-unstick），再换路子并说明换了什么。"
  );
}

export function deliveryNotice() {
  return (
    "Engineer 检查点（自动）：这一轮已经推送或开了 PR。汇报与 PR 描述要写清三件事：影响面（diff 之外会坏什么，ds-blast-radius）、验证证据（跑过的命令与结果，ds-verify-loop）、回滚方式；标题和描述按十秒可读写（ds-pr）。"
  );
}

export function scopeNotice(count) {
  return (
    "Engineer 检查点（自动）：这一轮已经成功改了 " +
    count +
    " 个代码文件。先写编号计划和每步验收（ds-plan-loop），再继续动；如果这是无意的扩散，先停下说清楚。"
  );
}

/**
 * 四条规则的优先级，守卫和 scripts/guard-replay.mjs 共用一份，避免两边漂移。
 * @returns 规则名，或 "none"
 */
export function decideRule(analysis, facts = {}) {
  if (analysis.failStreak >= FAIL_STREAK) return "unstick";
  if (analysis.evidenceMissing && !onlyDocumentation(analysis.mutatedFiles)) return "evidence";
  if (analysis.pushes > 0) return "delivery";
  if (analysis.mutatedCode.length >= SCOPE_LIMIT) return "scope";
  if (needsContextReset(facts)) return "context";
  return "none";
}

/** 长会话、还没写 PROGRESS.md。facts 由调用方从整个会话里算好。 */
export function needsContextReset(facts) {
  const events = facts.events ?? 0;
  const turn = facts.turn ?? 0;
  return events >= CONTEXT_MIN_EVENTS && turn >= CONTEXT_MIN_TURN && facts.wroteProgress !== true;
}

/** 会话里是否已经动过 PROGRESS.md（内层 dispatch 与直接调用都算）。 */
export function wroteProgressFile(events) {
  const WRITE_VERB = /(writeFileSync|appendFileSync|writeFile\(|>\s*\S*PROGRESS\.md|tee\s+\S*PROGRESS\.md)/;
  return events.some((event) => {
    const data = event?.data;
    if (data === null || data === undefined) return false;
    const isToolWrite =
      (event.type === "tool/ptc-dispatch" || event.type === "tool/call") &&
      (data.name === "write" || data.name === "edit");
    if (isToolWrite) {
      // 只认路径：正文里提到 PROGRESS.md（比如改 persona）不算写过。
      return targetsOf(data.arguments).some((file) => /(^|[\/])PROGRESS\.md$/.test(file));
    }
    // 很多人是在脚本里落盘的（heredoc / node -e），只认工具事件会漏，导致误报。
    const isBash =
      (event.type === "tool/ptc-dispatch" || event.type === "tool/call") && data.name === "bash";
    if (!isBash) return false;
    const command = commandOf(data.arguments);
    return command.includes("PROGRESS.md") && WRITE_VERB.test(command);
  });
}

export function contextNotice() {
  return "Engineer 检查点（自动）：这个会话已经很长，还没写过 PROGRESS.md。把目标、已验证的步骤、下一步各写一行进去（ds-context-reset），再继续；这个会话里我不会再提醒第二次。";
}

/**
 * 按这句话决定「要想多深」。
 *   off  —— 明显闲聊 / 问状态，且没有任务词（不用思考）
 *   max  —— 修 bug、重构、设计、评审、交付、计划这类容易想浅的活
 *   high —— 其余（默认档，多数任务够用）
 * 判据保守：拿不准就 high。
 */
const TRIVIAL = /(你好|您好|嗨|哈喽|谢谢|谢了|晚安|早安|现在几点|几点了|今天(几号|星期几)|天气|hello|hi\b|thanks|thx)/i;
const HARD = /(修|排查|调试|报错|失败|挂了|不工作|重构|架构|迁移|性能|设计|做个页面|做个界面|评审|审一下|发出去|合并|上线|计划|方案|多文件|整个项目|debug|refactor|migrate|redesign|ship|review)/i;

export function pickEffort(userText) {
  const text = typeof userText === "string" ? userText.trim() : "";
  if (text === "") return "high";
  if (HARD.test(text)) return "max";
  if (TRIVIAL.test(text) && text.length <= 24) return "off";
  return "high";
}

/**
 * 从用户的一句话认出流程，不用他报技能名。
 * 只认明确的说法；认不出来就返回 null，绝不猜。
 */
const INTENTS = [
  [/(解释一下|解释|怎么跑|怎么工作|怎么实现的|讲一下|说明一下|看懂|理解一下|什么原理|how does .* work|walk me through)/i,
    "ds-explain",
    "这轮像「解释」：按 ds-explain 三段走——是什么 → 怎么跑 → 为什么长这样；行为引用文件和行号，推断标明是推断。"],
  [/(发出去|合并|上线|开 ?pr|提 ?pr|生成 ?pr|ship it|merge)/i,
    "ds-ship",
    "这轮像「交付」：按 ds-ship 走——先跑检查、再算影响面、再开 PR 或合并；每步给证据。没把握能不能合就先停在 ready（ds-ready）。"],
  [/(审一下|评审|review 一下|看看有没有问题|挑毛病|第二意见|把关|帮我审|review)/i,
    "ds-review-loop",
    "这轮像「评审」：按 ds-review-loop 找一份 fresh 意见回环，或 ds-jury 要 2–3 个独立判断；只采纳有证据的反对。"],
  [/(到哪了|进展|做到哪|现在什么状态|catch ?up)/i,
    "ds-catchup",
    "这轮像「问进展」：按 ds-catchup 一分钟追上——改了什么、验证过什么、还差什么，并列出等你决定的事。"],
  [/(接手|继续这个 ?pr|take over)/i,
    "ds-adopt",
    "这轮像「接手」：按 ds-adopt 先读全文再动手，结束时把功劳记给原作者。"],
  [/(做个页面|做个界面|设计一下|改好看|重做界面|界面|(?:^|[^A-Za-z-])UI(?![A-Za-z]))/,
    "ds-design",
    "这轮像「界面」：先按 ds-design 定视觉方向（元素、层级、一个主行动），不做通用 AI 脸。"],
  [/(先规划|出个计划|列个步骤|分几步|怎么做比较好)/,
    "ds-plan-loop",
    "这轮像「要计划」：按 ds-plan-loop 先编号计划（每步带验收），过一遍再动手。"],
  [/(调试|修一下|修修|报错|不工作|挂了|跑不起来)/,
    "ds-tdd",
    "这轮像「修 bug」：按 ds-tdd 先写一条当前会失败的测试，再用 ds-verify-loop 跑到绿；两轮不绿换前提（ds-unstick）。"],
  [/(验证一下|测一下|跑一下测试|确认没坏)/,
    "ds-verify-loop",
    "这轮像「要验证」：跑最窄的真检查，把命令和结果贴进结论；跑不了就写「未验证」和原因。"],
];

export function routeIntent(userText) {
  if (typeof userText !== "string" || userText.trim() === "") return null;
  // 先认明确说法。
  for (const [pattern, skill, line] of INTENTS) {
    if (pattern.test(userText)) return { skill, line };
  }
  // 直接点名也算：不带斜杠的 ds-tdd / ds-ship 也认，省得记斜杠。
  const named = /\b(ds-[a-z][a-z0-9-]*)\b/i.exec(userText);
  if (named !== null) {
    const skill = named[1].toLowerCase();
    return {
      skill,
      line: "你点了 " + skill + "：先加载它的 SKILL.md 按里面的步骤走，别凭记忆模仿。",
    };
  }
  return null;
}

/** 本步认领的消息里的用户原话（pre-step 时这是唯一能拿到「这句话」的地方）。 */
export function claimedUserText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .filter((message) => message?.source?.kind === "user")
    .map((message) => (message.content ?? []).map((c) => c.text ?? "").join(" "))
    .join(" ")
    .trim();
}

/** 会话里最后一条用户原话；只认 source.kind = user 的消息。 */
export function lastUserText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "user/message" || event.data?.source?.kind !== "user") continue;
    return (event.data.content ?? []).map((c) => c.text ?? "").join(" ");
  }
  return "";
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
 * @param ctx cordis 上下文（Engineer mode 预设里挂载，天然只在这个模式生效）
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

  const contextDone = new Set();
  const routed = new Set();
  // 每个会话上次由守卫设定的强度；用户手动改过就记 null 并永久停手。
  const effortBySession = new Map();

  const applyEffort = (agent, userText) => {
    const model = agent?.model;
    if (model === undefined || typeof model.select !== "function" || typeof model.current !== "function") return;
    const selection = model.current();
    if (selection === undefined || selection.reasoningEffort === undefined) return; // 这个模型没有强度档
    const sessionId = agent.session.id;
    const remembered = effortBySession.get(sessionId);
    if (remembered === null) return; // 用户手动接管过
    if (remembered !== undefined && selection.reasoningEffort !== remembered) {
      effortBySession.set(sessionId, null); // 不是守卫设的 → 用户切的，退出
      return;
    }
    const desired = pickEffort(userText);
    if (desired === selection.reasoningEffort) {
      effortBySession.set(sessionId, desired);
      return;
    }
    model.select({ provider: selection.provider, model: selection.model, reasoningEffort: desired });
    effortBySession.set(sessionId, desired);
    appendGuardLog({ at: new Date().toISOString(), session: sessionId, turn: 0, rule: "effort:" + desired, surface: "pre-step", files: [] });
  };
  const decide = (agent, turn) => {
    const events = readEvents(agent?.session);
    const analysis = analyzeTurn(events, turn);
    const facts = { events: events.length, turn, wroteProgress: wroteProgressFile(events) };
    let rule = decideRule(analysis, facts);
    if (rule === "context" && contextDone.has(agent.session.id)) rule = "none";
    return { rule, analysis, facts };
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
      case "context":
        return contextNotice();
      default:
        return "";
    }
  };

  /**
   * 这条提醒该不该发、发了要不要占回合预算。
   * context 是每会话一次的旁路提示（自己带锁），不跟其他规则抢预算；
   * 其余规则共用每回合 2 条的上限。
   */
  const claim = (agent, turn, rule, atTurnEnd) => {
    const sessionId = agent.session.id;
    if (rule === "context") {
      if (contextDone.has(sessionId)) return false;
      return true;
    }
    const key = sessionId + ":" + turn;
    return atTurnEnd ? usedOf(key) < MAX_NOTICES : usedOf(key) < 1;
  };

  const spend = (agent, turn, rule, atTurnEnd) => {
    if (rule !== "context") remember(agent.session.id + ":" + turn);
    else contextDone.add(agent.session.id);
    void atTurnEnd;
  };

  // 1) 模型开口之前：把检查点挂在 messages 末尾，答案还没生成。
  ctx.on("agent/pre-step", async ({ agent, messages, step, turn, signal }, next) => {
    const decision = await next();
    try {
      if (decision?.kind !== "enter" || signal?.aborted) return decision;

      // 第一步先认意图：认出来就按流程走，不占预算，也不用用户报技能名。
      const events = readEvents(agent?.session);
      // 当前这句话在 pre-step 时还没写进会话，先从本步认领的消息里取。
      const userText = claimedUserText(messages) || lastUserText(events);
      if (step === 1) applyEffort(agent, userText);
      const route = step === 1 ? routeIntent(userText) : null;
      if (route !== null) {
        const routeKey = agent.session.id + ":" + turn;
        if (!routed.has(routeKey)) {
          routed.add(routeKey);
          appendGuardLog({ at: new Date().toISOString(), session: agent.session.id, turn, rule: "route:" + route.skill, surface: "pre-step", files: [] });
          return {
            ...decision,
            messages: [
              ...decision.messages,
              checkpoint(SOURCE_KIND + "-route-" + agent.session.id + "-" + turn, "Engineer 路由（自动）：" + route.line),
            ],
          };
        }
      }

      const verdict = decide(agent, turn);
      if (verdict.rule === "none") return decision;
      if (!claim(agent, turn, verdict.rule, false)) return decision;
      spend(agent, turn, verdict.rule, false);
      appendGuardLog({
        at: new Date().toISOString(),
        session: agent.session.id,
        turn,
        rule: verdict.rule,
        surface: "pre-step",
        files: verdict.analysis.mutatedFiles.slice(0, 5),
      });
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
      warnOnce("engineer guard: pre-step check failed: " + String((error && error.message) || error));
      return decision;
    }
  });

  // 2) 轮末兜底：模型还是要收尾，就 steer 一句让回合再走一步。
  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    try {
      if (typeof agent?.steer !== "function" || agent.session === undefined) return;
      const verdict = decide(agent, turn);
      if (verdict.rule === "none") return;
      if (!claim(agent, turn, verdict.rule, true)) return;
      spend(agent, turn, verdict.rule, true);
      appendGuardLog({
        at: new Date().toISOString(),
        session: agent.session.id,
        turn,
        rule: verdict.rule,
        surface: "turn-stopping",
        files: verdict.analysis.mutatedFiles.slice(0, 5),
      });
      agent.steer(
        checkpoint(SOURCE_KIND + "-" + agent.session.id + "-" + turn + "-stop", noticeFor(verdict, true)),
      );
    } catch (error) {
      warnOnce("engineer guard: turn-stopping check failed: " + String((error && error.message) || error));
    }
  });
}
