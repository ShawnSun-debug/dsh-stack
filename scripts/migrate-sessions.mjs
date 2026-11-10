#!/usr/bin/env node
/**
 * 把会话里记录的旧预设 id 迁到新 id。
 *
 * 两处落点：
 *   1. 会话日志 `sessions/<workspace>/<session>/session.v4.jsonl.zstd` 的头部行
 *      里 `"agentPreset":"<from>"`；不迁移的话 DSH 打开旧会话会抛
 *      `agent-preset/not-found`。
 *   2. 投影缓存 `storages/session_projcache/sessions/*.json` 的 `agentPreset.val`。
 *
 * 默认只报告（dry-run）。--apply 才写，写前把每个文件备份到
 * `$DSH_HOME/backup-preset-migration-<时间戳>/` 下的同一相对路径。
 * 正在写的会话（mtime 在 --active-within 分钟内）默认跳过，
 * 想一起改就加 --include-active（要在 DSH 关掉时跑）。
 *
 *   node scripts/migrate-sessions.mjs
 *   node scripts/migrate-sessions.mjs --apply
 *   node scripts/migrate-sessions.mjs --apply --include-active --active-within 0
 *   node scripts/migrate-sessions.mjs --from ds-stack --to engineer
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const value = (name, fallback) => {
  const at = argv.indexOf("--" + name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : fallback;
};

const HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const FROM = value("from", "ds-stack");
const TO = value("to", "engineer");
const APPLY = flag("apply");
const INCLUDE_ACTIVE = flag("include-active");
const ACTIVE_MINUTES = Number(value("active-within", "10"));
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const BACKUP = join(HOME, "backup-preset-migration-" + STAMP);

function walk(dir, suffix, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, suffix, found);
    else if (entry.name.endsWith(suffix)) found.push(full);
  }
  return found;
}

function backup(file) {
  const target = join(BACKUP, relative(HOME, file));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
}

function writeAtomic(file, data) {
  const temp = file + ".tmp-migrate";
  writeFileSync(temp, data);
  renameSync(temp, file);
}

function zstd(args, input) {
  const run = spawnSync("zstd", args, { input, maxBuffer: 512 * 1024 * 1024 });
  if (run.error) throw new Error("需要 zstd 命令：apt-get install -y zstd（" + run.error.message + "）");
  if (run.status !== 0) throw new Error("zstd 失败：" + String(run.stderr).slice(0, 200));
  return run.stdout;
}

const needle = Buffer.from('"agentPreset":"' + FROM + '"');
const replacement = Buffer.from('"agentPreset":"' + TO + '"');
const template = new RegExp('("agentPreset"\\s*:\\s*\\{[^}]*?"val"\\s*:\\s*)"' + FROM + '"');

const report = { logs: { hit: [], skipped: [] }, cache: { hit: [], skipped: [] }, errors: [] };

for (const file of walk(join(HOME, "sessions"), ".jsonl.zstd")) {
  try {
    const active = !INCLUDE_ACTIVE && Date.now() - statSync(file).mtimeMs < ACTIVE_MINUTES * 60e3;
    const raw = zstd(["-dc", file]);
    const at = raw.indexOf(needle);
    if (at < 0) continue;
    if (active) { report.logs.skipped.push(file); continue; }
    report.logs.hit.push(file);
    if (!APPLY) continue;
    const patched = Buffer.concat([raw.subarray(0, at), replacement, raw.subarray(at + needle.length)]);
    const packed = zstd(["-3", "-q", "-c"], patched);
    backup(file);
    writeAtomic(file, packed);
  } catch (error) {
    report.errors.push(file + ": " + error.message);
  }
}

for (const file of walk(join(HOME, "storages", "session_projcache", "sessions"), ".json")) {
  try {
    const text = readFileSync(file, "utf8");
    if (!text.includes('"' + FROM + '"')) continue;
    if (!template.test(text)) continue;
    report.cache.hit.push(file);
    if (!APPLY) continue;
    backup(file);
    writeAtomic(file, text.replace(template, '$1"' + TO + '"'));
  } catch (error) {
    report.errors.push(file + ": " + error.message);
  }
}

const mode = APPLY ? "apply" : "dry-run";
console.log(mode + ": preset " + FROM + " -> " + TO + " | home " + HOME);
console.log("session logs:   " + report.logs.hit.length + " to migrate, " + report.logs.skipped.length + " skipped (active)");
console.log("projcache rows: " + report.cache.hit.length + " to migrate");
if (report.errors.length) {
  console.log("errors:");
  for (const line of report.errors) console.log("  " + line);
}
if (!APPLY) console.log("nothing written; rerun with --apply");
else if (report.logs.hit.length || report.cache.hit.length) console.log("backup: " + BACKUP);
if (report.errors.length) process.exitCode = 1;
