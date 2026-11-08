/**
 * dsh-go 界面片段的合并/移除。
 *
 * 插件带一份 ui/go.json；安装器把它并进 $DSH_HOME/dsh-go/ui.json，
 * 卸载时只拿走自己那几项，用户自己加的胶囊/建议卡原样保留。
 *
 * 认一项的唯一标识是它的动作：send 比 text，command 比 name，open 比 page。
 * 用动作而不是标签，是因为用户可以改标签、我们不该重复插入同一件事。
 *
 * @module dsh-stack/go-ui
 */

/** 一项的唯一键；认不出来返回 null（不会参与合并，也不会被误删）。 */
export function actionKey(item) {
  const action = item?.action;
  if (action === null || typeof action !== "object") return null;
  switch (action.type) {
    case "send":
      return typeof action.text === "string" ? "send:" + action.text : null;
    case "command":
      return typeof action.name === "string" ? "command:" + action.name : null;
    case "open":
      return typeof action.page === "string" ? "open:" + action.page : null;
    default:
      return null;
  }
}

const ARRAYS = [
  ["composer", "quickActions"],
  ["emptyState", "suggestions"],
];

const clone = (value) => JSON.parse(JSON.stringify(value));

/** 把片段并进现有配置，只补缺的项。 */
export function mergeGoUi(existing, fragment) {
  const ui = existing !== null && typeof existing === "object" ? clone(existing) : { version: 1 };
  if (typeof ui.version !== "number") ui.version = 1;
  let added = 0;
  for (const [group, field] of ARRAYS) {
    const wanted = fragment?.[group]?.[field];
    if (!Array.isArray(wanted) || wanted.length === 0) continue;
    const current = Array.isArray(ui[group]?.[field]) ? ui[group][field] : [];
    const seen = new Set(current.map(actionKey).filter((key) => key !== null));
    const next = [...current];
    for (const item of wanted) {
      const key = actionKey(item);
      if (key !== null && seen.has(key)) continue;
      next.push(clone(item));
      if (key !== null) seen.add(key);
      added += 1;
    }
    if (next.length > 0) {
      ui[group] = { ...(ui[group] ?? {}), [field]: next };
    }
  }
  return { ui, added };
}

/** 从现有配置里拿走片段里的项；用户的其它项不动。 */
export function stripGoUi(existing, fragment) {
  if (existing === null || typeof existing !== "object") return { ui: existing, removed: 0 };
  const ui = clone(existing);
  let removed = 0;
  for (const [group, field] of ARRAYS) {
    const mine = new Set(
      (fragment?.[group]?.[field] ?? []).map(actionKey).filter((key) => key !== null),
    );
    if (mine.size === 0) continue;
    const current = ui[group]?.[field];
    if (!Array.isArray(current)) continue;
    const next = current.filter((item) => {
      const key = actionKey(item);
      if (key !== null && mine.has(key)) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (next.length === 0) delete ui[group][field];
    else ui[group][field] = next;
    if (ui[group] !== undefined && Object.keys(ui[group]).length === 0) delete ui[group];
  }
  return { ui, removed };
}
