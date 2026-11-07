#!/usr/bin/env node
/**
 * dsh-stack 安装器：把它注册成一个 profile bundle（这样设置里的插件清单才看得见它）。
 *
 *   node scripts/install.mjs --check
 *   node scripts/install.mjs --apply  --profile <name>
 *   node scripts/install.mjs --remove --profile <name>
 *   node scripts/install.mjs --verify --profile <name>   装完之后核对 profile 里到底写进去没有
 *
 * --apply 写三处（都留 .bak-<时间戳>）：
 *   1. profile/package.json 依赖 link:<本目录>
 *   2. profile/package.json 的 dsh.profile.bundles 追加 "dsh-stack"
 *   3. profile/node_modules/dsh-stack junction
 * 插件行由本包的 cordis.patch.yml 提供，加载器按 bundle 自动应用；profile 的 cordis.patch.yml 里
 * 若还留着早期手写的 row 会被移除，避免同一 provider 注册两次。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, symlinkSync, unlinkSync, readdirSync, lstatSync, cpSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_NAME = "dsh-stack";
const LEGACY_BEGIN = "# >>> dsh-stack (managed by dsh-stack/scripts/install.mjs) >>>";
const LEGACY_END = "# <<< dsh-stack <<<";
const SKILLS_DIR = join(HERE, "assets", "skills");

const argv = process.argv.slice(2);
const mode = argv[0] || "--check";
const at = argv.indexOf("--profile");
const PROFILE = at >= 0 ? argv[at + 1] : null;

const skills = existsSync(SKILLS_DIR) ? readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
console.log(`package: ${PKG_NAME} | resident skills: ${skills.length}`);

if (mode === "--check") {
  console.log("check: no profile touched");
  process.exit(0);
}
if (mode === "--verify") {
  if (!PROFILE) {
    console.error("usage: node scripts/install.mjs --verify --profile <name>");
    process.exit(2);
  }
  const dir = join(homedir(), ".dsh", "profiles", PROFILE);
  const pkgFile = join(dir, "package.json");
  const link = join(dir, "node_modules", PKG_NAME);
  const fails = [];
  const say = (ok, label, detail) => {
    console.log((ok ? "PASS " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) fails.push(label);
  };
  say(existsSync(dir), "profile exists", dir);
  if (!existsSync(pkgFile)) {
    console.log("FAIL package.json missing: " + pkgFile);
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  const dep = pkg.dependencies && pkg.dependencies[PKG_NAME];
  say(!!dep, "dependency declared", dep || "(missing)");
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  say(bundles.includes(PKG_NAME), "bundle registered", bundles.join(",") || "(empty)");
  say(existsSync(link), "package present in node_modules", link);
  say(existsSync(join(SKILLS_DIR, "ds-mode", "SKILL.md")), "resident skills on disk", skills.length + " skills");
  const patch = join(HERE, "cordis.patch.yml");
  if (existsSync(patch)) {
    const text = readFileSync(patch, "utf8");
    say(text.includes("preset-ds-stack"), "bundle patch has preset-ds-stack");
    say(text.includes("自动触发"), "bundle patch carries the auto-trigger rules");
  } else say(false, "bundle patch missing", patch);
  console.log("");
  console.log(fails.length ? "verify: FAILED — " + fails.join(", ") : "verify: ok — restart DSH, then pick 「DS Stack 模式」");
  process.exit(fails.length ? 1 : 0);
}
if (mode !== "--apply" && mode !== "--remove") {
  console.error("usage: node scripts/install.mjs [--check|--apply|--remove|--verify] --profile <name>");
  process.exit(1);
}
if (!PROFILE) {
  console.error("refusing to run without --profile");
  process.exit(2);
}

const PROFILE_DIR = join(homedir(), ".dsh", "profiles", PROFILE);
const PACKAGE_JSON = join(PROFILE_DIR, "package.json");
const PATCH_FILE = join(PROFILE_DIR, "cordis.patch.yml");
const LINK_DIR = join(PROFILE_DIR, "node_modules", PKG_NAME);
if (!existsSync(PROFILE_DIR)) {
  console.error("profile not found: " + PROFILE_DIR);
  process.exit(2);
}
const backup = (file) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(file, file + ".bak-" + stamp);
  console.log("backup:", file + ".bak-" + stamp);
};
const readProfile = () => JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));

function stripLegacyRow() {
  if (!existsSync(PATCH_FILE)) return;
  const text = readFileSync(PATCH_FILE, "utf8");
  const s = text.indexOf(LEGACY_BEGIN);
  if (s < 0) return;
  const e = text.indexOf(LEGACY_END, s);
  const after = e < 0 ? "" : text.slice(e + LEGACY_END.length);
  backup(PATCH_FILE);
  writeFileSync(PATCH_FILE, (text.slice(0, s) + after.replace(/^\r?\n/, "")).replace(/\s*$/, "") + "\n");
  console.log("legacy row: removed from", PATCH_FILE);
}

if (mode === "--apply") {
  const pkg = readProfile();
  pkg.dependencies = pkg.dependencies || {};
  const wanted = "link:" + HERE.replace(/\\/g, "/");
  let dirty = false;
  if (pkg.dependencies[PKG_NAME] !== wanted) {
    pkg.dependencies[PKG_NAME] = wanted;
    dirty = true;
    console.log("dependency:", wanted);
  } else console.log("dependency: already linked");
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : (pkg.dsh.profile.bundles = []);
  if (!bundles.includes(PKG_NAME)) {
    bundles.push(PKG_NAME);
    dirty = true;
    console.log("bundle: registered in dsh.profile.bundles");
  } else console.log("bundle: already registered");
  if (dirty) {
    backup(PACKAGE_JSON);
    writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + "\n");
  }
  if (existsSync(LINK_DIR)) console.log("link: already present");
  else {
    mkdirSync(dirname(LINK_DIR), { recursive: true });
    // Windows 用 junction，类 Unix 用目录符号链接；两者都不行（权限、FAT、部分移动端沙箱）就复制目录。
    // DS_STACK_NO_SYMLINK=1 可强制走复制路径，用来在一台机器上验证退化分支。
    try {
      if (process.env.DS_STACK_NO_SYMLINK === "1") { const e = new Error("forced copy"); e.code = "NO_SYMLINK"; throw e; }
      symlinkSync(HERE, LINK_DIR, process.platform === "win32" ? "junction" : "dir");
      console.log("link:", LINK_DIR, "->", HERE);
    } catch (err) {
      cpSync(HERE, LINK_DIR, { recursive: true });
      console.log("link: symlink failed (" + (err && err.code) + "), copied the folder instead:", LINK_DIR);
    }
  }
  stripLegacyRow();
  console.log("done: restart DSH, then look for dsh-stack in the plugin inventory");
} else {
  const pkg = readProfile();
  let dirty = false;
  if (pkg.dependencies && PKG_NAME in pkg.dependencies) {
    delete pkg.dependencies[PKG_NAME];
    dirty = true;
    console.log("dependency: removed");
  }
  const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
  if (Array.isArray(bundles) && bundles.includes(PKG_NAME)) {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PKG_NAME);
    dirty = true;
    console.log("bundle: unregistered");
  }
  if (dirty) {
    backup(PACKAGE_JSON);
    writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + "\n");
  }
  stripLegacyRow();
  if (existsSync(LINK_DIR)) {
    if (lstatSync(LINK_DIR).isSymbolicLink()) unlinkSync(LINK_DIR);
    else rmSync(LINK_DIR, { recursive: true, force: true });
    console.log("link: removed");
  }
}
