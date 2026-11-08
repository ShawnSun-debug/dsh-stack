/**
 * 打包契约：package.json 的 files 必须覆盖运行与重建要用到的文件。
 * 这条测试存在的理由：0.7.1 的 tarball 里没有 presets/persona.txt，
 * 拿到 tarball 的人无法重建 cordis.patch.yml，也改不了人设。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** 运行时或重建时会被读到的路径，必须被打包。 */
const REQUIRED = [
  "lib/index.js",
  "lib/guard.js",
  "cordis.patch.yml",
  "presets/persona.txt",
  "assets/skills/ds-mode/SKILL.md",
  "skills.manifest.json",
  "scripts/install.mjs",
  "scripts/build-bundle.mjs",
  "README.md",
];

/** files 里的条目既可能是文件也可能是目录，按前缀匹配。 */
function coveredByFiles(relative) {
  return (pkg.files ?? []).some((entry) => relative === entry || relative.startsWith(entry + "/"));
}

test("package.json 的 files 覆盖运行与重建需要的文件", () => {
  const missing = REQUIRED.filter((relative) => existsSync(join(ROOT, relative)) && !coveredByFiles(relative));
  assert.deepEqual(missing, [], "这些文件不会被打包：" + missing.join(", "));
});

test("files 里的条目在仓库里真实存在", () => {
  const missing = (pkg.files ?? []).filter((entry) => !existsSync(join(ROOT, entry)));
  assert.deepEqual(missing, [], "files 里列了不存在的条目：" + missing.join(", "));
});
