import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installGuard } from "./guard.js";

/**
 * dsh-engineer-mode —— 常驻技能载体。
 *
 * 这个包不是"技能便捷分发"通道，它的作用是把 deepseek-stack 的 29 个技能固定成
 * runtime 里的一层常驻底账：profile 装了这个包，技能就一定在，不依赖
 * ~/.agents/skills 里那些随时可能被安装器改写、清理或忘装的散装目录。
 *
 * 优先级阶梯（数字小的赢；见 @deepseek-ai/dsh-skill-filesystem）：
 *   project .dsh 100 / project .agents 200 / custom 300 / ~/.dsh/skills 400 / ~/.agents/skills 500 / bundled 600
 *
 * 本 provider 用 600（= BUNDLED_SKILL_RANK）。因此在已经存在散装副本的机器上，
 * 散装（500）优先、本包兜底；散装被删或换机器时，本包继续供上同名技能。
 * 这就是"叠加式"：常驻保证存在，覆盖权留给本地文件。
 *
 * @module dsh-engineer-mode
 */

const PROVIDER_NAME = "engineer";
const RANK = 600; // bundled tier: below every filesystem root, so local copies override
const SKILLS_DIR = fileURLToPath(new URL("../assets/skills/", import.meta.url));

function parseFrontmatter(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const at = raw.indexOf(":");
    if (at <= 0) continue;
    const key = raw.slice(0, at).trim();
    if (key) fields[key] = raw.slice(at + 1).trim().replace(/^["']/, "").replace(/["']$/, "");
  }
  return fields;
}

let catalogPromise;
async function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
      const catalog = new Map();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        let body;
        try {
          body = await readFile(join(SKILLS_DIR, entry.name, "SKILL.md"), "utf8");
        } catch {
          continue;
        }
        const fields = parseFrontmatter(body);
        catalog.set(entry.name, {
          name: fields.name || entry.name,
          description: fields.description || "",
          dir: entry.name,
        });
      }
      return catalog;
    })();
  }
  return catalogPromise;
}

const provider = {
  name: PROVIDER_NAME,
  async list() {
    const catalog = await loadCatalog();
    return [...catalog.values()].map((skill) => ({
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER_NAME,
      source: "bundled",
      resourceBase: { kind: "directory", path: join(SKILLS_DIR, skill.dir) },
      rank: RANK,
      locator: new URL(`../assets/skills/${skill.dir}/SKILL.md`, import.meta.url),
    }));
  },
  async get(candidate) {
    const catalog = await loadCatalog();
    const skill = [...catalog.values()].find((entry) => entry.name === candidate.name);
    if (!skill) throw new Error(`unknown engineer skill: ${candidate.name}`);
    const body = await readFile(join(SKILLS_DIR, skill.dir, "SKILL.md"), "utf8");
    return {
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER_NAME,
      source: "bundled",
      resourceBase: { kind: "directory", path: join(SKILLS_DIR, skill.dir) },
      content: body.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""),
    };
  },
};

export const name = "skill-engineer";
export const inject = ["skills"];
export function apply(ctx) {
  ctx.skills.registerProvider(() => provider);
  installGuard(ctx);
}
