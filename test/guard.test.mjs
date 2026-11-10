import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTurn, claimedUserText, decideRule, installGuard, lastUserText, onlyDocumentation, needsContextReset, evidenceNotice, evidenceSteer, deliveryNotice, guardLogPath, pickEffort, routeIntent, scopeNotice, suggestCheck, wroteProgressFile } from "../lib/guard.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 守卫会往 $DSH_HOME/dsh-stack/guard.log 记账；测试必须指向临时目录，别写进用户真实日志。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-guard-tests-"));

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
  assert.equal(decision.messages[0].source.kind, "engineer-guard");
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

test("一轮改了 6 个代码文件：提醒先出计划", () => {
  const events = [ptcCall(1, "r1")];
  for (const i of [1, 2, 3, 4, 5, 6]) events.push(dispatch("r1", "edit", { file_path: "/tmp/f" + i + ".js" }));
  const a = analyzeTurn(events, 1);
  assert.equal(a.mutatedCode.length, 6);
  assert.match(scopeNotice(a.mutatedCode.length), /6 个代码文件/);
  assert.match(scopeNotice(a.mutatedCode.length), /ds-plan-loop/);
});

test("成批写文档不算扩散：5 个 md 不进 scope", () => {
  const events = [ptcCall(1, "r1")];
  for (const i of [1, 2, 3, 4, 5]) events.push(dispatch("r1", "write", { file_path: "/tmp/doc" + i + ".md" }));
  const a = analyzeTurn(events, 1);
  assert.equal(a.mutatedCode.length, 0);
  assert.equal(a.mutatedAll.length, 5);
});

test("临时仓库探针的 push 不算交付", () => {
  const events = [
    ptcCall(1, "r1"),
    dispatch("r1", "bash", { command: "d=$(mktemp -d); git init --bare $d/r.git; git push $d/r.git" }),
  ];
  assert.equal(analyzeTurn(events, 1).pushes, 0);
});

test("真推送仍然算交付", () => {
  const events = [ptcCall(1, "r1"), dispatch("r1", "bash", { command: "git push -u origin feat/x" })];
  assert.equal(analyzeTurn(events, 1).pushes, 1);
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

const longSession = (n = 620) => Array.from({ length: n }, () => ({ type: "step/start", data: {} }));
const ctx2 = () => fakeCtx();

test("长会话没写过 PROGRESS.md：判定为 context", () => {
  const facts = { events: 620, turn: 7, wroteProgress: false };
  assert.equal(needsContextReset(facts), true);
  assert.equal(decideRule(analyzeTurn([], 7), facts), "context");
});

test("写过 PROGRESS.md、或会话还短：不提醒", () => {
  assert.equal(needsContextReset({ events: 620, turn: 7, wroteProgress: true }), false);
  assert.equal(needsContextReset({ events: 300, turn: 7, wroteProgress: false }), false);
  assert.equal(needsContextReset({ events: 620, turn: 3, wroteProgress: false }), false);
});

test("PROGRESS.md 只认写入，读到的不算", () => {
  const touched = [{ type: "tool/ptc-dispatch", data: { name: "edit", arguments: { file_path: "/w/PROGRESS.md" } } }];
  const mentioned = [{ type: "tool/ptc-dispatch", data: { name: "bash", arguments: { command: "cat PROGRESS.md" } } }];
  assert.equal(wroteProgressFile(touched), true);
  assert.equal(wroteProgressFile(mentioned), false);
});

test("脚本里落盘的 PROGRESS.md 也算写过", () => {
  const viaScript = [{
    type: "tool/ptc-dispatch",
    data: { name: "bash", arguments: { command: "node -e 'fs.writeFileSync(\"/root/workspace/PROGRESS.md\", body)'" } },
  }];
  const viaRedirect = [{
    type: "tool/ptc-dispatch",
    data: { name: "bash", arguments: { command: "cat > PROGRESS.md <<EOF\n# x\nEOF" } },
  }];
  assert.equal(wroteProgressFile(viaScript), true);
  assert.equal(wroteProgressFile(viaRedirect), true);
});

test("context 每个会话只提醒一次", async () => {
  const ctx = fakeCtx();
  installGuard(ctx);
  const agent = fakeAgent(longSession(), { id: "s-long" });
  const preStep = ctx.handlers.get("agent/pre-step");
  const next = async () => ({ kind: "enter", messages: [] });

  const first = await preStep({ agent, step: 2, turn: 7, signal: { aborted: false } }, next);
  assert.equal(first.messages.length, 1);
  assert.match(first.messages[0].content[0].text, /PROGRESS\.md/);

  const second = await preStep({ agent, step: 2, turn: 8, signal: { aborted: false } }, next);
  assert.equal(second.messages.length, 0, "换回合也不再提醒");
});

test("context 不占回合预算：同回合还能让 evidence 响一次", async () => {
  const events = longSession(620);
  const agent = fakeAgent(events, { id: "s-ctx" });
  const steers = [];
  agent.steer = (m) => steers.push(m);
  const ctx = ctx2();
  installGuard(ctx);
  const next = async () => ({ kind: "enter", messages: [] });

  const first = await ctx.handlers.get("agent/pre-step")(
    { agent, step: 1, turn: 6, signal: { aborted: false } },
    next,
  );
  assert.equal(first.messages.length, 1);
  assert.match(first.messages[0].content[0].text, /PROGRESS\.md/);

  events.push(call(6, "c9", "write", { file_path: "/tmp/ctx-x.js" }), result(6, "c9"));
  ctx.handlers.get("agent/turn-stopping")({ agent, turn: 6 });
  assert.equal(steers.length, 1, "context 没吃掉 evidence 的名额");
  assert.match(steers[0].content[0].text, /ctx-x\.js/);
});

test("按文件类型给出具体验证命令", () => {
  assert.equal(suggestCheck(["/w/a.js"]), "node --check /w/a.js");
  assert.equal(suggestCheck(["/w/a.ts"]), "npx tsc --noEmit");
  assert.equal(suggestCheck(["/w/a.py"]), "python3 -m py_compile /w/a.py");
  assert.equal(suggestCheck(["/w/a.go"]), "go build ./...");
  assert.equal(suggestCheck(["/w/README.md"]), null);
});

test("提醒里带上具体命令", () => {
  assert.match(evidenceNotice(["/w/a.js"]), /node --check \/w\/a\.js/);
  assert.match(evidenceSteer(["/w/a.js"]), /node --check \/w\/a\.js/);
  assert.match(evidenceNotice(["/w/a.unknown"]), /跑一条能证明它的命令/);
});

test("守卫写日志：一行一条，带规则与会话", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-guard-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const ctx = fakeCtx();
    installGuard(ctx);
    const events = [ptcCall(1, "r1"), dispatch("r1", "edit", { file_path: "/tmp/log-a.js" })];
    const agent = fakeAgent(events, { id: "s-log" });
    await ctx.handlers.get("agent/pre-step")(
      { agent, step: 2, turn: 1, signal: { aborted: false } },
      async () => ({ kind: "enter", messages: [] }),
    );
    const line = readFileSync(join(home, "dsh-engineer-mode", "guard.log"), "utf8").trim();
    const entry = JSON.parse(line);
    assert.equal(entry.rule, "evidence");
    assert.equal(entry.surface, "pre-step");
    assert.equal(entry.session, "s-log");
    assert.equal(entry.turn, 1);
    assert.deepEqual(entry.files, ["/tmp/log-a.js"]);
    assert.equal(guardLogPath(), join(home, "dsh-engineer-mode", "guard.log"));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("认得出常见意图，不用报技能名", () => {
  assert.equal(routeIntent("解释一下这段代码怎么跑的").skill, "ds-explain");
  assert.equal(routeIntent("把它发出去吧").skill, "ds-ship");
  assert.equal(routeIntent("帮我审一下这个改动").skill, "ds-review-loop");
  assert.equal(routeIntent("现在到哪了").skill, "ds-catchup");
  assert.equal(routeIntent("接手这个 PR").skill, "ds-adopt");
  assert.equal(routeIntent("做个页面").skill, "ds-design");
  assert.equal(routeIntent("今天天气怎么样"), null);
  assert.equal(routeIntent(""), null);
});

test("只认用户原话，不认系统塞进来的消息", () => {
  const events = [
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "解释一下 a.js" }] } },
    { type: "user/message", data: { source: { kind: "engineer-guard" }, content: [{ type: "text", text: "检查点" }] } },
    { type: "user/message", data: { source: { kind: "time-context" }, content: [{ type: "text", text: "2026-11-08" }] } },
  ];
  assert.equal(lastUserText(events), "解释一下 a.js");
});

test("第一步就自动按流程走，第二步不重复", async () => {
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "解释一下这段代码" }] } },
  ];
  const ctx = fakeCtx();
  installGuard(ctx);
  const agent = fakeAgent(events, { id: "s-route" });
  const next = async () => ({ kind: "enter", messages: [] });
  const preStep = ctx.handlers.get("agent/pre-step");

  const first = await preStep({ agent, step: 1, turn: 1, signal: { aborted: false } }, next);
  assert.equal(first.messages.length, 1);
  assert.match(first.messages[0].content[0].text, /Engineer 路由/);
  assert.match(first.messages[0].content[0].text, /ds-explain/);

  const second = await preStep({ agent, step: 2, turn: 1, signal: { aborted: false } }, next);
  assert.equal(second.messages.length, 0, "同回合不重复路由");
});

test("不带斜杠的技能名也认", () => {
  assert.equal(routeIntent("ds-tdd").skill, "ds-tdd");
  assert.equal(routeIntent("用 ds-ship 把这单做了").skill, "ds-ship");
  assert.match(routeIntent("ds-jury").line, /加载它的 SKILL\.md/);
});

test("强度映射：闲聊降、干活升、拿不准用默认", () => {
  assert.equal(pickEffort("你好"), "off");
  assert.equal(pickEffort("现在几点了"), "off");
  assert.equal(pickEffort("继续"), "high");
  assert.equal(pickEffort("修一下这个 bug"), "max");
  assert.equal(pickEffort("把这次改动发出去"), "max");
  assert.equal(pickEffort("帮我解释一下这段"), "high");
});

const fakeModel = (initial) => {
  let current = initial;
  const selected = [];
  return {
    current: () => ({ ...current }),
    select: (next) => {
      selected.push(next);
      current = { ...next };
    },
    selected,
    setManual: (selection) => {
      current = { ...selection };
    },
  };
};

const userEvents = (text) => [
  { type: "turn/start", data: { turn: 1 } },
  { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } },
];

test("第一步按意图改强度，同回合第二步不再改", async () => {
  const ctx = fakeCtx();
  installGuard(ctx);
  const model = fakeModel({ provider: "p", model: "m", reasoningEffort: "high" });
  const agent = { session: { id: "s-eff", snapshotEvents: () => userEvents("修一下这个 bug") }, steer() {}, model };
  const preStep = ctx.handlers.get("agent/pre-step");
  const next = async () => ({ kind: "enter", messages: [] });

  await preStep({ agent, step: 1, turn: 1, signal: { aborted: false } }, next);
  assert.equal(model.selected.length, 1);
  assert.deepEqual(model.selected[0], { provider: "p", model: "m", reasoningEffort: "max" });

  await preStep({ agent, step: 2, turn: 1, signal: { aborted: false } }, next);
  assert.equal(model.selected.length, 1, "同回合不重复切");
});

test("用户手动切过强度：本会话不再自动改", async () => {
  const ctx = fakeCtx();
  installGuard(ctx);
  const model = fakeModel({ provider: "p", model: "m", reasoningEffort: "high" });
  const agent = { session: { id: "s-manual", snapshotEvents: () => userEvents("修一下这个 bug") }, steer() {}, model };
  const preStep = ctx.handlers.get("agent/pre-step");
  const next = async () => ({ kind: "enter", messages: [] });

  await preStep({ agent, step: 1, turn: 1, signal: { aborted: false } }, next); // 守卫设成 max
  model.setManual({ provider: "p", model: "m", reasoningEffort: "off" }); // 用户手动切
  await preStep({ agent, step: 1, turn: 2, signal: { aborted: false } }, next);
  const before = model.selected.length;
  await preStep({ agent, step: 1, turn: 3, signal: { aborted: false } }, next);
  assert.equal(model.selected.length, before, "手动接管后不再自动切");
});

test("认领的消息优先于会话历史：不会拿上一句判断", async () => {
  const ctx = fakeCtx();
  installGuard(ctx);
  const model = fakeModel({ provider: "p", model: "m", reasoningEffort: "max" });
  // 会话里最后一句是「把A做到 dsh-stack」，本步认领的是「现在几点了」
  const events = userEvents("把A做到 dsh-stack");
  const agent = { session: { id: "s-claim", snapshotEvents: () => events }, steer() {}, model };
  const claimed = [{ source: { kind: "user" }, content: [{ type: "text", text: "现在几点了" }] }];

  await ctx.handlers.get("agent/pre-step")(
    { agent, messages: claimed, step: 1, turn: 1, signal: { aborted: false } },
    async () => ({ kind: "enter", messages: [] }),
  );
  assert.equal(model.selected.length, 1);
  assert.equal(model.selected[0].reasoningEffort, "off", "按这一句判，不是上一句");
  assert.equal(claimedUserText(claimed), "现在几点了");
});
