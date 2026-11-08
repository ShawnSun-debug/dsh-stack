import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTurn, installGuard, onlyDocumentation, evidenceNotice, deliveryNotice, scopeNotice } from "../lib/guard.js";

const call = (turn, callId, name, args) => ({
  type: "tool/call",
  data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
});
const ptcCall = (turn, callId) => ({
  type: "tool/call",
  data: { turn, step: 1, callId, name: "run_code", arguments: "{}" },
});
const dispatch = (rootCallId, name, args, isError = false) => ({
  type: "tool/ptc-dispatch",
  data: {
    rootCallId,
    parentCallId: rootCallId,
    subCallId: rootCallId + ":ptc:1",
    name,
    arguments: args,
    isError,
  },
});
const result = (turn, callId, isError = false) => ({
  type: "tool/result",
  data: { turn, step: 1, message: { toolCallId: callId, isError } },
});

function fakeCtx() {
  const handlers = new Map();
  const warns = [];
  return {
    handlers,
    warns,
    on(event, fn) {
      handlers.set(event, fn);
    },
    logger: { warn: (m) => warns.push(m) },
    skills: { registerProvider() {} },
  };
}

function fakeAgent(events, { id = "s1", steer } = {}) {
  return {
    session: { id, snapshotEvents: () => events },
    steer: steer ?? (() => {}),
  };
}

test("改了文件却没跑检查：判定为缺证据，并报出被改的文件", () => {
  const events = [call(1, "c1", "write", { file_path: "a.js" }), result(1, "c1")];
  const a = analyzeTurn(events, 1);
  assert.equal(a.evidenceMissing, true);
  assert.deepEqual(a.mutatedFiles, ["a.js"]);
});

test("改完跑了成功的 bash：不算缺证据", () => {
  const events = [
    call(1, "c1", "edit", { file_path: "a.js" }),
    result(1, "c1"),
    call(1, "c2", "bash", { command: "node --check a.js" }),
    result(1, "c2"),
  ];
  assert.equal(analyzeTurn(events, 1).evidenceMissing, false);
});

test("失败的 bash 不算证据", () => {
  const events = [
    call(1, "c1", "write", { file_path: "a.js" }),
    result(1, "c1"),
    call(1, "c2", "bash", { command: "npm test" }),
    result(1, "c2", true),
  ];
  assert.equal(analyzeTurn(events, 1).evidenceMissing, true);
});

test("只改文档：豁免，不出提醒", () => {
  assert.equal(onlyDocumentation(["README.md", "notes.txt"]), true);
  assert.equal(onlyDocumentation(["README.md", "a.js"]), false);
});

test("pre-step：缺证据时在 messages 末尾加一条 checkpoint", async () => {
  const ctx = fakeCtx();
  installGuard(ctx);
  const events = [call(1, "c1", "write", { file_path: "a.js" }), result(1, "c1")];
  const agent = fakeAgent(events);
  const preStep = ctx.handlers.get("agent/pre-step");
  const decision = await preStep(
    { agent, step: 2, turn: 1, signal: { aborted: false } },
    async () => ({ kind: "enter", messages: [] }),
  );
  assert.equal(decision.messages.length, 1);
  assert.equal(decision.messages[0].role, "user");
  assert.equal(decision.messages[0].source.kind, "ds-stack-guard");
  assert.match(decision.messages[0].content[0].text, /a\.js/);
});

test("pre-step：没有违规时原样返回", async () => {
  const ctx = fakeCtx();
  installGuard(ctx);
  const mk = () => ({ kind: "enter", messages: [] });
  const preStep = ctx.handlers.get("agent/pre-step");
  const decision = await preStep(
    { agent: fakeAgent([]), step: 1, turn: 1, signal: { aborted: false } },
    async () => mk(),
  );
  assert.deepEqual(decision.messages, []);
});

test("pre-step 只提醒一次，轮末再 steer 一次，总共两次", async () => {
  const ctx = fakeCtx();
  installGuard(ctx);
  const events = [call(1, "c1", "write", { file_path: "a.js" }), result(1, "c1")];
  const steers = [];
  const agent = fakeAgent(events, { steer: (m) => steers.push(m) });
  const preStep = ctx.handlers.get("agent/pre-step");
  const next = async () => ({ kind: "enter", messages: [] });

  const first = await preStep({ agent, step: 2, turn: 1, signal: { aborted: false } }, next);
  assert.equal(first.messages.length, 1);
  const second = await preStep({ agent, step: 3, turn: 1, signal: { aborted: false } }, next);
  assert.equal(second.messages.length, 0);

  const turnStopping = ctx.handlers.get("agent/turn-stopping");
  turnStopping({ agent, turn: 1 });
  assert.equal(steers.length, 1);
  assert.match(steers[0].content[0].text, /a\.js/);

  turnStopping({ agent, turn: 1 });
  assert.equal(steers.length, 1, "预算用完后不再 steer");
});

test("连续两次失败：提醒换前提", async () => {
  const ctx = fakeCtx();
  installGuard(ctx);
  const events = [
    call(1, "c1", "bash", { command: "npm test" }),
    result(1, "c1", true),
    call(1, "c2", "bash", { command: "npm test" }),
    result(1, "c2", true),
  ];
  const agent = fakeAgent(events);
  const decision = await ctx.handlers.get("agent/pre-step")(
    { agent, step: 3, turn: 1, signal: { aborted: false } },
    async () => ({ kind: "enter", messages: [] }),
  );
  assert.equal(decision.messages.length, 1);
  assert.match(decision.messages[0].content[0].text, /2 次工具调用都失败了/);
});

test("守卫内部出错：只 warn，不改回合", async () => {
  const ctx = fakeCtx();
  installGuard(ctx);
  const agent = {
    session: {
      id: "s9",
      snapshotEvents() {
        throw new Error("boom");
      },
    },
    steer() {
      throw new Error("should not steer");
    },
  };
  const base = { kind: "enter", messages: [] };
  const decision = await ctx.handlers.get("agent/pre-step")(
    { agent, step: 1, turn: 1, signal: { aborted: false } },
    async () => base,
  );
  assert.deepEqual(decision.messages, []);
  assert.equal(ctx.warns.length, 1);
});

test("提醒文本指向被改的文件", () => {
  assert.match(evidenceNotice(["a.js"]), /a\.js/);
});

test("PTC 模式：run_code 里跑的 edit 也算改了文件", () => {
  const events = [
    ptcCall(1, "r1"),
    dispatch("r1", "edit", { file_path: "/tmp/a.js" }),
  ];
  const a = analyzeTurn(events, 1);
  assert.equal(a.evidenceMissing, true);
  assert.deepEqual(a.mutatedFiles, ["/tmp/a.js"]);
});

test("PTC 模式：edit 之后内层 bash 成功，不算缺证据", () => {
  const events = [
    ptcCall(1, "r1"),
    dispatch("r1", "edit", { file_path: "/tmp/a.js" }),
    dispatch("r1", "bash", { command: "node --check /tmp/a.js" }),
  ];
  assert.equal(analyzeTurn(events, 1).evidenceMissing, false);
});

test("PTC 模式：内层 bash 失败不算证据，并计入连续失败", () => {
  const events = [
    ptcCall(1, "r1"),
    dispatch("r1", "edit", { file_path: "/tmp/a.js" }),
    dispatch("r1", "bash", { command: "npm test" }, true),
  ];
  const a = analyzeTurn(events, 1);
  assert.equal(a.evidenceMissing, true);
  assert.equal(a.failStreak, 1);
});

test("PTC 模式：两次内层失败 = 连续失败 2", () => {
  const events = [
    ptcCall(1, "r1"),
    dispatch("r1", "bash", { command: "npm test" }, true),
    dispatch("r1", "bash", { command: "npm test" }, true),
  ];
  assert.equal(analyzeTurn(events, 1).failStreak, 2);
});

test("PTC 模式：别的回合的内层调用不计入本回合", () => {
  const events = [
    ptcCall(1, "r1"),
    dispatch("r1", "bash", { command: "ls" }, true),
    ptcCall(2, "r2"),
    dispatch("r2", "edit", { file_path: "/tmp/b.js" }),
  ];
  const a = analyzeTurn(events, 2);
  assert.equal(a.evidenceMissing, true);
  assert.equal(a.failStreak, 0);
  assert.deepEqual(a.mutatedFiles, ["/tmp/b.js"]);
});

test("推送过：提醒影响面、证据和 PR 可读性", () => {
  const events = [
    ptcCall(1, "r1"),
    dispatch("r1", "bash", { command: "git push -u origin feat/x" }),
  ];
  const a = analyzeTurn(events, 1);
  assert.equal(a.pushes, 1);
  const text = deliveryNotice();
  assert.match(text, /影响面/);
  assert.match(text, /ds-pr/);
});

test("一轮改了 5 个不同文件：提醒先出计划", () => {
  const events = [ptcCall(1, "r1")];
  for (const i of [1, 2, 3, 4, 5]) events.push(dispatch("r1", "edit", { file_path: "/tmp/f" + i + ".js" }));
  const a = analyzeTurn(events, 1);
  assert.equal(a.mutatedAll.length, 5);
  assert.match(scopeNotice(a.mutatedAll.length), /5 个不同文件/);
  assert.match(scopeNotice(a.mutatedAll.length), /ds-plan-loop/);
});

test("pre-step 在推送后会注入 delivery 检查点", async () => {
  const ctx = fakeCtx();
  installGuard(ctx);
  const events = [ptcCall(1, "r1"), dispatch("r1", "bash", { command: "git push" })];
  const agent = fakeAgent(events, { id: "s-delivery" });
  const decision = await ctx.handlers.get("agent/pre-step")(
    { agent, step: 2, turn: 1, signal: { aborted: false } },
    async () => ({ kind: "enter", messages: [] }),
  );
  assert.equal(decision.messages.length, 1);
  assert.match(decision.messages[0].content[0].text, /影响面/);
});
