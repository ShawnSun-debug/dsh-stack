#!/usr/bin/env node
/**
 * guard-replay —— 按 step 逐步回放真实会话，看守卫当时会不会响。
 *
 *   node scripts/guard-replay.mjs                # 最近一个会话
 *   node scripts/guard-replay.mjs <session 文件>  # 指定会话
 *   node scripts/guard-replay.mjs --all          # 全部历史会话，合计
 *
 * 为什么按 step 而不是按回合：守卫挂在 agent/pre-step，每步都看一次；
 * 一次违规常常两个步骤后就补上了，按回合收尾状态统计会把它们全漏掉。
 *
 * 判定和预算都直接复用 lib/guard.js：decideRule() 一份判定，预算按
 * 「pre-step 每回合 1 条 + 轮末 1 条」，context 走独立通道（每会话一次，不占预算）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { analyzeTurn, decideRule, turnOutcomes, wroteProgressFile } from "../lib/guard.js";

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const BUG_WORDS = /(报错|错误|失败|挂了|不工作|跑不起来|崩溃|异常|修一下|修复|\bbug\b|\berror\b|\bexception\b|\bfix\b)/i;
const TEST_CMD = /(npm (run )?test|node --test|\bjest\b|\bvitest\b|\bpytest\b|go test|cargo test|\.test\.|\.spec\.|_test\.)/i;
const TEST_FILE = /(\.(test|spec)\.|_test\.|(^|\/)tests?\/)/i;

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
  const ranked = allSessionFiles().map((full) => ({ full, t: fs.statSync(full).mtimeMs }));
  ranked.sort((a, b) => b.t - a.t);
  if (ranked.length === 0) throw new Error("找不到会话文件：把路径直接传给脚本");
  return ranked[0].full;
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

/** 候选规则（没有上线）：修 bug 类回合改了非测试文件、却没有任何测试命令。 */
function candidateTdd(prefix, turn, userText) {
  if (!BUG_WORDS.test(userText)) return false;
  const outcomes = turnOutcomes(prefix, turn);
  const edited = outcomes.some(
    (o) => !o.isError && (o.name === "write" || o.name === "edit") && o.targets.some((f) => !TEST_FILE.test(f)),
  );
  if (!edited) return false;
  return !outcomes.some((o) => o.name === "bash" && TEST_CMD.test(o.command));
}

/** 在一个会话上逐步回放。 */
function simulate(events) {
  const userTexts = userTextsByTurn(events);
  const perTurn = new Map();
  const totals = { unstick: 0, evidence: 0, delivery: 0, scope: 0, context: 0 };
  const candidates = { tdd: 0 };
  let contextFired = false;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "step/start" && event.type !== "turn/end") continue;
    const turn = event.data.turn;
    const step = event.data.step ?? -1;
    const prefix = events.slice(0, index + 1);
    const entry = perTurn.get(turn) ?? { notices: 0, spent: 0 };

    const facts = { events: prefix.length, turn, wroteProgress: wroteProgressFile(prefix) };
    const rule = decideRule(analyzeTurn(prefix, turn), facts);

    if (rule === "context") {
      if (!contextFired) {
        contextFired = true;
        totals.context += 1;
        entry.notices += 1;
        entry.firstRule = entry.firstRule ?? rule;
        entry.firstStep = entry.firstStep ?? (step >= 0 ? step : "收尾");
      }
    } else if (rule !== "none") {
      const allowed = event.type === "step/start" ? entry.spent < 1 : entry.spent < 2;
      if (allowed) {
        totals[rule] += 1;
        entry.spent += 1;
        entry.notices += 1;
        entry.firstRule = entry.firstRule ?? rule;
        entry.firstStep = entry.firstStep ?? (step >= 0 ? step : "收尾");
      }
    }

    const userText = (userTexts.get(turn) ?? []).join(" ");
    if (!entry.tdd && candidateTdd(prefix, turn, userText)) {
      entry.tdd = true;
      candidates.tdd += 1;
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
    };
  });
  return { rows, totals, candidates, turns };
}

if (process.argv.includes("--all")) {
  const grand = { sessions: 0, turns: 0, unstick: 0, evidence: 0, delivery: 0, scope: 0, context: 0, tdd: 0 };
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
    for (const key of ["unstick", "evidence", "delivery", "scope", "context"]) grand[key] += result.totals[key];
    grand.tdd += result.candidates.tdd;
    perSession.push({
      session: path.basename(path.dirname(file)).slice(0, 16),
      回合: result.turns.length,
      evidence: result.totals.evidence,
      context: result.totals.context,
      tdd: result.candidates.tdd,
    });
  }
  perSession.sort((a, b) => b.回合 - a.回合);
  console.table(perSession.slice(0, 10));
  console.log("会话数:", grand.sessions, "| 总回合:", grand.turns);
  console.log("现有规则合计:", JSON.stringify({
    unstick: grand.unstick, evidence: grand.evidence, delivery: grand.delivery, scope: grand.scope, context: grand.context,
  }));
  console.log("候选规则合计（未上线）:", JSON.stringify({ tdd: grand.tdd }));
} else {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : newestSession();
  const { rows, totals, candidates, turns } = simulate(loadEvents(file));
  console.table(rows);
  console.log("会话:", path.basename(path.dirname(file)), "| 回合:", turns.length);
  console.log("现有规则触发:", JSON.stringify(totals));
  console.log("候选规则（未上线）:", JSON.stringify(candidates));
}
