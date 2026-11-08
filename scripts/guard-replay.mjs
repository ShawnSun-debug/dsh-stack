#!/usr/bin/env node
/**
 * guard-replay —— 按 step 逐步回放真实会话，看守卫当时会不会响。
 *
 *   node scripts/guard-replay.mjs                # 最近一个会话
 *   node scripts/guard-replay.mjs <session 文件>  # 指定会话
 *   node scripts/guard-replay.mjs --all          # 全部历史会话，只看合计
 *
 * 为什么按 step 而不是按回合：守卫挂在 agent/pre-step，每步都看一次；
 * 一次违规常常两个步骤后就补上了，按回合收尾状态统计会把它们全漏掉。
 *
 * 候选规则（tdd / context-reset）只在本脚本里跑，没有进 preset：先看数据再决定。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { analyzeTurn, decideRule, turnOutcomes } from "../lib/guard.js";

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const DOC = /\.(md|mdx|txt|rst|adoc)$/i;
const BUG_WORDS = /(报错|错误|失败|挂了|不工作|跑不起来|崩溃|异常|修一下|修复|\bbug\b|\berror\b|\bexception\b|\bfix\b)/i;
const TEST_CMD = /(npm (run )?test|node --test|\bjest\b|\bvitest\b|\bpytest\b|go test|cargo test|\.test\.|\.spec\.|_test\.)/i;
const TEST_FILE = /(\.(test|spec)\.|_test\.|(^|\/)tests?\/)/i;
const PUSH = /\bgit\s+push\b|\bgh\s+pr\s+(?:create|merge)\b/i;
const TEMP_REPO = /(mktemp|\.\.|--bare|git init)/i;
const NON_CODE = /\.(md|mdx|txt|rst|adoc|json|ya?ml|csv|tsv)$/i;

function isSessionFile(name) {
  return name === "session.v4.jsonl.zstd" || name.endsWith(".jsonl");
}

function allSessionFiles() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (isSessionFile(entry.name)) found.push(full);
    }
  };
  walk(path.join(HOME, "sessions"), 0);
  return found;
}

function newestSession() {
  const candidates = allSessionFiles().map((full) => ({ full, t: fs.statSync(full).mtimeMs }));
  candidates.sort((a, b) => b.t - a.t);
  if (candidates.length === 0) throw new Error("找不到会话文件：把路径直接传给脚本");
  return candidates[0].full;
}

function loadEvents(file) {
  const raw = file.endsWith(".zstd")
    ? zlib.zstdDecompressSync(fs.readFileSync(file)).toString("utf8")
    : fs.readFileSync(file, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).event ?? JSON.parse(line));
}

/** 用户原话按回合归属：两条 turn/start 之间的用户消息（source=user）算下一个回合。 */
function userTextsByTurn(events) {
  const byTurn = new Map();
  let pending = [];
  for (const event of events) {
    if (event.type === "turn/start") {
      byTurn.set(event.data.turn, pending);
      pending = [];
      continue;
    }
    if (event.type === "user/message" && event.data?.source?.kind === "user") {
      pending.push((event.data.content ?? []).map((c) => c.text ?? "").join(" "));
    }
  }
  return byTurn;
}

/** 与守卫共用同一份判定，别再各写一套。 */
function ruleOf(analysis) {
  const rule = decideRule(analysis);
  return rule === "none" ? "-" : rule;
}

/** 候选 A：修 bug 类回合改了非测试文件、却没有任何测试命令。 */
function candidateTdd(prefix, turn, userText) {
  if (!BUG_WORDS.test(userText)) return false;
  const outcomes = turnOutcomes(prefix, turn);
  const edited = outcomes.filter(
    (o) => !o.isError && (o.name === "write" || o.name === "edit") && o.targets.some((f) => !TEST_FILE.test(f)),
  );
  if (edited.length === 0) return false;
  return !outcomes.some((o) => o.name === "bash" && TEST_CMD.test(o.command));
}

/** 候选 B：会话很长、turn ≥ 6，且从没写过 PROGRESS.md。整会话只算一次。 */
function candidateContextReset(prefix, turn) {
  if (turn < 6 || prefix.length < 600) return false;
  return !prefix.some(
    (e) =>
      e.type === "tool/ptc-dispatch" &&
      (e.data.name === "write" || e.data.name === "edit") &&
      JSON.stringify(e.data.arguments ?? {}).includes("PROGRESS.md"),
  );
}

/**
 * 在一个会话上逐步回放，返回逐回合结果与合计。
 * 预算按 lib/guard.js 来：pre-step 每回合最多 1 条，轮末最多再补 1 条。
 */
function simulate(events) {
  const userTexts = userTextsByTurn(events);
  const perTurn = new Map();
  const totals = { unstick: 0, evidence: 0, delivery: 0, scope: 0 };
  const candidates = { tdd: 0, reset: 0 };
  const tightened = { delivery: 0, scope: 0 };
  const pushSamples = [];
  let resetFired = false;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const isJoin = event.type === "step/start" || event.type === "turn/end";
    if (!isJoin) continue;
    const turn = event.data.turn;
    const step = event.data.step ?? -1;
    const prefix = events.slice(0, index + 1);
    const entry = perTurn.get(turn) ?? { notices: 0, spent: 0 };

    if (entry.spent < 2) {
      const analysis = analyzeTurn(prefix, turn);
      const rule = ruleOf(analysis);
      const allowed = event.type === "step/start" ? entry.spent < 1 : entry.spent < 2;
      const outcomes = turnOutcomes(prefix, turn);
      if (!entry.tightDelivery) {
        const realPush = outcomes.some(
          (o) => o.name === "bash" && !o.isError && PUSH.test(o.command) && !TEMP_REPO.test(o.command),
        );
        if (realPush && analysis.pushes > 0) {
          entry.tightDelivery = true;
          tightened.delivery += 1;
        }
      }
      if (!entry.tightScope) {
        const codeFiles = new Set(
          outcomes
            .filter((o) => !o.isError && (o.name === "write" || o.name === "edit"))
            .flatMap((o) => o.targets)
            .filter((f) => !NON_CODE.test(f)),
        );
        if (codeFiles.size >= 6) {
          entry.tightScope = true;
          tightened.scope += 1;
        }
      }
      if (rule !== "-" && allowed) {
        totals[rule] += 1;
        entry.spent += 1;
        entry.notices += 1;
        entry.firstRule = entry.firstRule ?? rule;
        entry.firstStep = entry.firstStep ?? (step >= 0 ? step : "收尾");
        if (rule === "delivery" && pushSamples.length < 5) {
          for (const o of turnOutcomes(prefix, turn)) {
            if (o.name === "bash" && /\bgit\s+push\b|\bgh\s+pr\s+(?:create|merge)\b/i.test(o.command) && pushSamples.length < 5) {
              pushSamples.push(o.command.replace(/\s+/g, " ").slice(0, 90));
            }
          }
        }
      }
    }

    const userText = (userTexts.get(turn) ?? []).join(" ");
    if (!entry.tdd && candidateTdd(prefix, turn, userText)) {
      entry.tdd = true;
      candidates.tdd += 1;
    }
    if (!resetFired && candidateContextReset(prefix, turn)) {
      resetFired = true;
      entry.reset = true;
      candidates.reset += 1;
    }
    perTurn.set(turn, entry);
  }

  const turns = events.filter((e) => e.type === "turn/start").map((e) => e.data.turn);
  const rows = turns.map((turn) => {
    const entry = perTurn.get(turn) ?? {};
    return {
      turn,
      首条规则: entry.firstRule ?? "-",
      步号: entry.firstStep ?? "",
      本回合提醒: entry.notices ?? 0,
      候选tdd: entry.tdd ? "Y" : "",
      候选reset: entry.reset ? "Y" : "",
    };
  });
  return { rows, totals, candidates, tightened, turns, events, pushSamples };
}

if (process.argv.includes("--all")) {
  const grand = { sessions: 0, turns: 0, unstick: 0, evidence: 0, delivery: 0, scope: 0, tdd: 0, reset: 0, tightDelivery: 0, tightScope: 0, pushSamples: [] };
  const perSession = [];
  for (const file of allSessionFiles()) {
    let result;
    try {
      result = simulate(loadEvents(file));
    } catch {
      continue;
    }
    if (result.turns.length === 0) continue;
    grand.sessions += 1;
    grand.turns += result.turns.length;
    for (const key of ["unstick", "evidence", "delivery", "scope"]) grand[key] += result.totals[key];
    grand.tdd += result.candidates.tdd;
    grand.reset += result.candidates.reset;
    grand.tightDelivery += result.tightened.delivery;
    grand.tightScope += result.tightened.scope;
    for (const sample of result.pushSamples) if (grand.pushSamples.length < 5) grand.pushSamples.push(sample);
    perSession.push({
      session: path.basename(path.dirname(file)).slice(0, 16),
      回合: result.turns.length,
      evidence: result.totals.evidence,
      tdd: result.candidates.tdd,
      reset: result.candidates.reset,
    });
  }
  perSession.sort((a, b) => b.回合 - a.回合);
  console.table(perSession.slice(0, 10));
  console.log("会话数:", grand.sessions, "| 总回合:", grand.turns);
  console.log("现有规则合计:", JSON.stringify({
    unstick: grand.unstick, evidence: grand.evidence, delivery: grand.delivery, scope: grand.scope,
  }));
  console.log("候选规则合计:", JSON.stringify({ tdd: grand.tdd, reset: grand.reset }));
  console.log("收紧后合计:", JSON.stringify({ delivery: grand.tightDelivery, scope: grand.tightScope }));
  if (grand.pushSamples.length) {
    console.log("push 命中样例：");
    for (const sample of grand.pushSamples) console.log("  -", sample);
  }
} else {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : newestSession();
  const { rows, totals, candidates, turns, events } = simulate(loadEvents(file));
  console.table(rows);
  console.log("会话:", path.basename(path.dirname(file)), "| 回合:", turns.length, "| 事件:", events.length);
  console.log("现有规则触发（步级）:", JSON.stringify(totals));
  console.log("候选规则（只测量，未上线）:", JSON.stringify(candidates));
}
