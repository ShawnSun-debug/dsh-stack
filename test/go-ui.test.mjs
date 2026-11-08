import test from "node:test";
import assert from "node:assert/strict";
import { actionKey, mergeGoUi, stripGoUi } from "../lib/go-ui.mjs";

const fragment = {
  version: 1,
  composer: { quickActions: [{ label: "解释", action: { type: "send", text: "解释一下" } }] },
  emptyState: { suggestions: [{ title: "跑测试", action: { type: "send", text: "跑一遍测试" } }] },
};

test("空配置：片段原样并进去", () => {
  const { ui, added } = mergeGoUi(undefined, fragment);
  assert.equal(added, 2);
  assert.equal(ui.version, 1);
  assert.equal(ui.composer.quickActions.length, 1);
  assert.equal(ui.emptyState.suggestions.length, 1);
});

test("重复安装幂等：已有的不再加", () => {
  const first = mergeGoUi(undefined, fragment).ui;
  const second = mergeGoUi(first, fragment);
  assert.equal(second.added, 0);
  assert.deepEqual(second.ui, first);
});

test("用户自己的胶囊保留，顺序不动", () => {
  const existing = {
    version: 1,
    composer: { quickActions: [{ label: "我的", action: { type: "send", text: "我自己的话" } }] },
  };
  const { ui, added } = mergeGoUi(existing, fragment);
  assert.equal(added, 2, "一颗胶囊 + 一张建议卡");
  assert.deepEqual(ui.composer.quickActions.map((a) => a.label), ["我的", "解释"]);
});

test("卸载只拿走自己的项", () => {
  const installed = mergeGoUi(
    { version: 1, composer: { quickActions: [{ label: "我的", action: { type: "send", text: "我自己的话" } }] } },
    fragment,
  ).ui;
  const { ui, removed } = stripGoUi(installed, fragment);
  assert.equal(removed, 2);
  assert.deepEqual(ui.composer.quickActions.map((a) => a.label), ["我的"]);
  assert.equal(ui.emptyState, undefined, "我们自己建的组，空了就整组删掉");
});

test("认不出的动作不参与合并也不被误删", () => {
  const weird = { label: "x", action: { type: "url", url: "https://example.com" } };
  assert.equal(actionKey(weird), null);
  const { ui } = mergeGoUi({ version: 1, composer: { quickActions: [weird] } }, fragment);
  assert.equal(ui.composer.quickActions.length, 2);
  const stripped = stripGoUi({ version: 1, composer: { quickActions: [weird] } }, fragment);
  assert.equal(stripped.removed, 0);
  assert.equal(stripped.ui.composer.quickActions.length, 1);
});
