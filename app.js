/* 鸣潮周本计数器 v2 — 核心逻辑
 * 口径与数据结构遵守项目 spec/rules.md 与 spec/schema.json（version 2）。
 * 三个计数：进本 entries / 领奖 claims（每周全周本共享上限）/ 声骸 echoes（对应 COST4 声骸掉落）。
 * 本地存储（localStorage），无后端，无网络上报。
 */
(() => {
"use strict";

/** 应用版本（与 android/app/build.gradle 的 versionName 保持一致） */
const APP_VERSION = "3.19.0";
const BUILD_DATE = "2026-10-18";

const STORAGE_KEY = "wuwa-weekly-counter/v1";   // 键名沿用，结构 version 在数据内
const SCHEMA_VERSION = 2;
const LOG_MAX = 1000;              // log 流水上限（撤销只需要尾部）
const UNDO_WINDOW_MS = 10 * 60000; // 只允许撤销最近 10 分钟内的最后一步
const LONGPRESS_MS = 480;          // 长按进入编辑模式
const CHART_MAX_WEEKS = 12;        // 趋势图最多展示的周数
const CHART_COLORS = ["#6d87ff", "#3ddc97", "#f0b357", "#e5484d", "#9d6dff", "#22d3ee"];

const DEFAULT_BOSSES = [
  // 主力周本（enabled）；material = 每次领奖掉落的技能升级材料（×3/次），来自《周本清单1017.xls》
  { id: "seq-principle-battle-song",    name: "定序诸演之律·战歌重奏", aliases: [], emoji: "🎼", echoName: "共鸣回响·天演溯心",     material: "演轮残蜕",     enabled: true },
  { id: "ember-apocalypse-battle-song", name: "烬夜天启之章·战歌重奏", aliases: [], emoji: "🌌", echoName: "共鸣回响·鸣式·利维亚坦", material: "深洋的咒诅",   enabled: true },
  // 后续周本（预置停用：内置图标已随包，开打前在「周本」页点「启用」即可）
  { id: "fate-fragment-wheel-battle-song",  name: "命途断章之轮·战歌重奏", aliases: [], emoji: "🎯", echoName: "共鸣回响·芙露德莉斯",       material: "鸢尾盛开之日", enabled: false },
  { id: "fallen-guilt-hall-battle-song",    name: "失坠困咎之庭·战歌重奏", aliases: [], emoji: "🎯", echoName: "千傀重楼",                   material: "天衢琉璃之心", enabled: false },
  { id: "scarlet-curtain-battle-song",      name: "彼世猩红之幕·战歌重奏", aliases: [], emoji: "🎯", echoName: "赫卡忒",                     material: "冥扉的欢觑",   enabled: false },
  { id: "crownless-colossus-battle-song",   name: "无冠巨像之心·战歌重奏", aliases: [], emoji: "🎯", echoName: "无妄者",                     material: "无妄之羽",     enabled: false },
  { id: "destiny-duel-battle-song",         name: "时序命定之争·战歌重奏", aliases: [], emoji: "🎯", echoName: "角",                         material: "岁时之角刃",   enabled: false },
  { id: "bygone-lament-bell-battle-song",   name: "昔日咏叹之钟·战歌重奏", aliases: [], emoji: "🎯", echoName: "鸣钟之龟",                   material: "碑趺古钟",     enabled: false },
  { id: "lost-star-gate-battle-song",       name: "星海迷途之扉·战歌重奏", aliases: [], emoji: "🎯", echoName: "辛吉勒姆",                   material: "忆中沉金",     enabled: false },
  // 双声骸周本：echoes1 / echoes2 分开计数，echoes = 两者之和
  { id: "void-birth-seed-battle-song",      name: "虚妄诞生之种·战歌重奏", aliases: [], emoji: "🎯", echoName: "共鸣回响·鸣式·虚造神型", echoName2: "共鸣回响·达妮娅", material: "质问的我们", enabled: false },
];

/** 把缺失的默认周本并入现有列表（老数据/旧备份也能拿到新预置周本；周本不可删除，合并永远安全、幂等） */
function mergeDefaultBosses(list) {
  let merged = 0;
  for (const d of DEFAULT_BOSSES) {
    if (!list.some(b => b.id === d.id)) {
      list.push({ ...d, aliases: [...d.aliases] });
      merged++;
    }
  }
  return merged;
}

/** 回填：声骸名 / 第二声骸名 / 技能材料（内置目录已有、本地为空时补上；幂等，不覆盖用户手填值） */
function backfillEchoNames(list) {
  let n = 0;
  for (const b of list) {
    const def = DEFAULT_BOSSES.find(d => d.id === b.id);
    if (!def) continue;
    if (!b.echoName && def.echoName) { b.echoName = def.echoName; n++; }
    if (!b.echoName2 && def.echoName2) { b.echoName2 = def.echoName2; n++; }
    if (!b.material && def.material) { b.material = def.material; n++; }
  }
  return n;
}

/** 已知名称修正（用户确认游戏内为「定序诸演之律」，早期默认误写「诸理」；改名不改 ID，历史数据不受影响） */
const NAME_FIXUPS = { "定序诸理之律·战歌重奏": "定序诸演之律·战歌重奏" };
function applyNameFixups(list) {
  let n = 0;
  for (const b of list) {
    if (NAME_FIXUPS[b.name]) { b.name = NAME_FIXUPS[b.name]; n++; }
    // 清理早期内置的内部代号别名（战歌重奏A / 战歌重奏B），用户自定义别名保留
    if (Array.isArray(b.aliases)) {
      const kept = b.aliases.filter(a => !/^战歌重奏[AB]$/.test(String(a).trim()));
      if (kept.length !== b.aliases.length) { b.aliases = kept; n++; }
    }
  }
  return n;
}

/* ───────────────────────── 状态 ───────────────────────── */

function defaultState() {
  return {
    version: SCHEMA_VERSION,
    settings: { resetHour: 4, resetWeekday: 1, weeklyClaimLimit: 3, weeklyClaimScope: "shared" },
    bosses: DEFAULT_BOSSES.map(b => ({ ...b, aliases: [...b.aliases] })),
    weeks: {},   // weekId -> { bossId: {entries, claims, echoes} }
    totals: {},  // bossId -> { entries, claims, echoes }
    log: [],     // {id, ts, bossId, type: "entry"|"claim"|"echo", weekId}
  };
}

/** v1 → v2 逐级迁移（schema.json migration.v1_to_v2） */
function migrate(fromVersion, st) {
  if (fromVersion < 2) {
    st.settings = { weeklyClaimScope: "shared", ...(st.settings || {}) };
    st.settings.weeklyClaimScope = "shared";
    for (const w of Object.values(st.weeks || {}))
      for (const b of Object.values(w)) if (b.echoes == null) b.echoes = 0;
    for (const t of Object.values(st.totals || {})) if (t.echoes == null) t.echoes = 0;
    st.bosses = (st.bosses || []).map(b => {
      const def = DEFAULT_BOSSES.find(d => d.id === b.id);
      return { ...b, echoName: b.echoName || (def ? def.echoName : "") };
    });
    st.version = 2;
  }
  return st;
}

/** bucket 清洗（load 与 import 共用）：剔除单数脏字段（v2 早期 bug 残留），数值下限 0；
 *  v2.3 起 echoes1/echoes2 = 两个声骸各自计数，echoes = 两者之和（旧数据全部归入 echoes1） */
function sanitizeBucket(o) {
  if (!o || typeof o !== "object") return { entries: 0, claims: 0, echoes: 0, echoes1: 0, echoes2: 0 };
  delete o.entry; delete o.claim; delete o.echo;
  o.entries = Math.max(0, o.entries || 0);
  o.claims = Math.max(0, o.claims || 0);
  o.echoes = Math.max(0, o.echoes || 0);
  if (o.echoes1 == null) o.echoes1 = o.echoes; // 旧数据迁移：历史声骸全部计入第一个声骸
  if (o.echoes2 == null) o.echoes2 = 0;
  o.echoes1 = Math.max(0, o.echoes1); o.echoes2 = Math.max(0, o.echoes2);
  // 不变量：echoes = echoes1 + echoes2（容忍脏数据，以分项为准）
  o.echoes = o.echoes1 + o.echoes2;
  return o;
}

let state = load();

function load() {
  let raw = null, needSave = false;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      raw = JSON.parse(stored);
      if (raw && typeof raw === "object" && Array.isArray(raw.bosses)) {
        const v = raw.version || 1;
        if (v < SCHEMA_VERSION) { migrate(v, raw); needSave = true; }
      }
    }
  } catch { raw = null; }
  // 解析失败/缺失 → 全新默认态
  const parsed = (raw && typeof raw === "object" && Array.isArray(raw.bosses)) ? raw : defaultState();
  const base = defaultState();
  const st = {
    ...base, ...parsed,
    version: SCHEMA_VERSION,
    settings: { ...base.settings, ...parsed.settings },
    weeks: parsed.weeks || {},
    totals: parsed.totals || {},
    log: Array.isArray(parsed.log) ? parsed.log : [],
    bosses: parsed.bosses.map(b => ({
      ...b,
      aliases: Array.isArray(b.aliases) ? b.aliases : [],
      echoName: b.echoName || "",
      echoName2: b.echoName2 || "",
      material: b.material || "",
      icon: (typeof b.icon === "string" && b.icon.startsWith("data:image/")) ? b.icon : "",
      enabled: b.enabled !== false,
    })),
  };
  // 防御性清洗：① 剔除 v2 早期 bug 残留的单数脏字段（entry/claim/echo，值为 null）；
  // ② 任何缺 echoes 的 bucket 补 0
  for (const w of Object.values(st.weeks)) {
    if (w && typeof w === "object") for (const b of Object.values(w)) sanitizeBucket(b);
  }
  for (const t of Object.values(st.totals)) sanitizeBucket(t);
  // 新版本预置的周本并入（如 8 个后打周本），并立即落盘
  if (mergeDefaultBosses(st.bosses) > 0) needSave = true;
  // 已知名称修正（诸理→诸演）同步落盘
  if (applyNameFixups(st.bosses) > 0) needSave = true;
  // 声骸名回填（内置目录已有、本地为空时补上）
  if (backfillEchoNames(st.bosses) > 0) needSave = true;
  // 迁移过的数据立即回写（升级一次就永久 v2，不必等首次点击）
  if (needSave) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(st)); } catch { /* 内存态为准 */ }
  }
  return st;
}

let dirtyVersion = 0;     // 每次落盘 +1（用于自动上传的"是否已推送"判断）
let pushedVersion = 0;
let autoPushTimer = 0;

function save() {
  try {
    state.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    dirtyVersion++;
    scheduleAutoPush();
  } catch { toast("保存失败：浏览器存储已满或被禁用"); }
}

/* ───────────────────────── 周界计算 ───────────────────────── */

/** 返回当前周界 Date（最近一个 resetWeekday 的 resetHour，<= now） */
function weekBoundary(now = new Date()) {
  const { resetWeekday: wd, resetHour: hr } = state.settings;
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hr, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (d.getDay() === wd && d <= now) return d;
    d = new Date(d.getTime() - 3600000);
  }
  d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hr, 0, 0, 0);
  while (!(d.getDay() === wd && d <= now)) d = new Date(d.getTime() - 86400000);
  return d;
}

/** ISO 周号：2026-W26 */
function weekIdOf(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function currentWeekId() { return weekIdOf(weekBoundary()); }
function nextReset() { return new Date(weekBoundary().getTime() + 7 * 86400000); }

function weekRangeText(wid) {
  const m = /^(\d{4})-W(\d{2})$/.exec(wid);
  if (!m) return "";
  const year = +m[1], week = +m[2];
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() + (week - 1) * 7 - ((jan4.getUTCDay() || 7) - 1));
  const sun = new Date(monday.getTime() + 6 * 86400000);
  const f = d => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${f(monday)} – ${f(sun)}`;
}

/* ───────────────────────── 计数操作 ───────────────────────── */

function ensureWeek(weekId) {
  if (!state.weeks[weekId]) state.weeks[weekId] = {};
  return state.weeks[weekId];
}
function bucket(weekId, bossId) {
  const w = ensureWeek(weekId);
  if (!w[bossId]) w[bossId] = { entries: 0, claims: 0, echoes: 0, echoes1: 0, echoes2: 0 };
  const b = w[bossId];
  if (b.echoes1 == null) b.echoes1 = b.echoes || 0;
  if (b.echoes2 == null) b.echoes2 = 0;
  return b;
}
function total(bossId) {
  if (!state.totals[bossId]) state.totals[bossId] = { entries: 0, claims: 0, echoes: 0, echoes1: 0, echoes2: 0 };
  const t = state.totals[bossId];
  if (t.echoes1 == null) t.echoes1 = t.echoes || 0;
  if (t.echoes2 == null) t.echoes2 = 0;
  return t;
}

/** 本周全部周本的领奖总数（v2：共享上限口径） */
function weekClaimTotal(weekId) {
  const w = state.weeks[weekId] || {};
  return Object.values(w).reduce((s, b) => s + (b.claims || 0), 0);
}

let logSeq = 0;
function nextLogId() {
  logSeq += 1;
  return `log-${Date.now().toString(36)}-${logSeq}`;
}

/** 按操作类型对 bucket 应用 ±1。
 *  entry=进本 claim=领奖 echo=主声骸 echo2=第二声骸（echoes 恒为 echoes1+echoes2） */
function applyDelta(b, type, sign) {
  if (!b) return;
  if (type === "entry") { b.entries = Math.max(0, (b.entries || 0) + sign); return; }
  if (type === "claim") { b.claims = Math.max(0, (b.claims || 0) + sign); return; }
  if (type === "echo")  b.echoes1 = Math.max(0, (b.echoes1 || 0) + sign);
  if (type === "echo2") b.echoes2 = Math.max(0, (b.echoes2 || 0) + sign);
  b.echoes = Math.max(0, (b.echoes1 || 0) + (b.echoes2 || 0));
}

/** 加计数。type: "entry" | "claim" | "echo" | "echo2" */
function addCount(bossId, type) {
  const weekId = currentWeekId();
  const b = bucket(weekId, bossId);
  const t = total(bossId);
  applyDelta(b, type, +1);
  applyDelta(t, type, +1);

  // 共享上限提醒：超录允许（rules §3），但给出提示
  if (type === "claim" && state.settings.weeklyClaimLimit > 0) {
    const used = weekClaimTotal(weekId);
    if (used > state.settings.weeklyClaimLimit) {
      toast(`已记录，但本周领奖已超共享上限 ${state.settings.weeklyClaimLimit} 次`);
    }
  }

  state.log.push({ id: nextLogId(), ts: new Date().toISOString(), bossId, type, weekId });
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
  save();
  render();
}

/** 撤销最近一步（rules §1：三处同步回退，不得低于 0） */
function undo() {
  const last = state.log[state.log.length - 1];
  if (!last) { toast("没有可撤销的操作"); return; }
  if (Date.now() - new Date(last.ts).getTime() > UNDO_WINDOW_MS) {
    toast("最近一步超过 10 分钟，不可撤销");
    return;
  }
  const w = state.weeks[last.weekId];
  const b = w && w[last.bossId];
  const t = state.totals[last.bossId];
  applyDelta(b, last.type, -1);
  applyDelta(t, last.type, -1);
  state.log.pop();
  save();
  render();
  toast("已撤销");
}

/* ───────────────────────── 编辑模式（误点保护） ───────────────────────── */
let editMode = false;

function enterEdit() {
  if (editMode) return;
  editMode = true;
  render();
  toast("已进入编辑模式，直接改数字即可");
}
function exitEdit() {
  if (!editMode) return;
  editMode = false;
  render();
}

/** 编辑模式下改写某周本本周数字；totals 按差值同步，不记 log（rules §7） */
function setWeekValue(bossId, field, raw) {
  const v = Math.max(0, Math.floor(Number(raw) || 0));
  const weekId = currentWeekId();
  const b = bucket(weekId, bossId);
  const t = total(bossId);
  if (field === "echoes") {
    // 声骸总数编辑：差值计入第一个声骸，保持 echoes = echoes1 + echoes2
    const d = v - (b.echoes || 0);
    if (!d) return;
    b.echoes1 = Math.max(0, (b.echoes1 || 0) + d);
    b.echoes = b.echoes1 + (b.echoes2 || 0);
    t.echoes1 = Math.max(0, (t.echoes1 || 0) + d);
    t.echoes = t.echoes1 + (t.echoes2 || 0);
    save();
    return;
  }
  const old = b[field] || 0;
  if (v === old) return;
  b[field] = v;
  t[field] = Math.max(0, (t[field] || 0) + (v - old));
  save();
}

/* ───────────────────────── 周本管理 ───────────────────────── */

/** 逐字拼音（用于周本列表按「拼音字母序」排序；忽略声调，严格按字母比较）。
 *  只覆盖内置 10 个周本用到的字；用户新加名字里的生字回退到 localeCompare。 */
const PINYIN_CHARS = {
  定: "ding", 序: "xu", 诸: "zhu", 演: "yan", 之: "zhi", 律: "lv",
  战: "zhan", 歌: "ge", 重: "chong", 奏: "zou",
  烬: "jin", 夜: "ye", 天: "tian", 启: "qi", 章: "zhang",
  命: "ming", 途: "tu", 断: "duan", 轮: "lun",
  失: "shi", 坠: "zhui", 困: "kun", 咎: "jiu", 庭: "ting",
  彼: "bi", 世: "shi", 猩: "xing", 红: "hong", 幕: "mu",
  无: "wu", 冠: "guan", 巨: "ju", 像: "xiang", 心: "xin",
  时: "shi", 争: "zheng", 昔: "xi", 日: "ri", 咏: "yong", 叹: "tan", 钟: "zhong",
  星: "xing", 海: "hai", 迷: "mi", 扉: "fei",
  虚: "xu", 妄: "wang", 诞: "dan", 生: "sheng", 种: "zhong",
};

/** 取「拼音首字母序列」并按 A→Z 逐位比较（用户口径）：
 *  定序诸演之律·战歌重奏 → d, x, z, y, z, l, (·跳过) z, g, c, z …
 *  先比第 1 个字的首字母，相同再比第 2 个，依此类推；·/空白/括号等非字母字符跳过。 */
function pinyinInitialsOf(name) {
  const letters = [];
  let allKnown = true;
  for (const ch of name) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      const py = PINYIN_CHARS[ch];
      if (py) letters.push(py[0]);
      else { letters.push(ch); allKnown = false; } // 生字：回退整名 localeCompare
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      letters.push(ch.toLowerCase());
    }
  }
  return { key: letters.join(""), allKnown };
}

/** 周本列表排序：启用的在前、停用的在后；组内按「拼音首字母序列」A→Z（逐字比较） */
function sortBossList(list) {
  return [...list].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const ka = pinyinInitialsOf(a.name), kb = pinyinInitialsOf(b.name);
    if (ka.allKnown && kb.allKnown) return ka.key < kb.key ? -1 : (ka.key > kb.key ? 1 : 0);
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

function slugify(name) {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (ascii) return ascii;
  return "boss-" + Date.now().toString(36);
}

function addBoss(name, echoName, echoName2, material, emoji, aliases, icon) {
  const id = slugify(name);
  if (state.bosses.some(b => b.id === id)) { toast("已存在同名/同 ID 周本"); return false; }
  state.bosses.push({
    id, name, echoName: echoName || "", echoName2: echoName2 || "",
    material: material || "", emoji: emoji || "🎯", icon: icon || "", aliases, enabled: true,
  });
  save(); render();
  toast(`已添加「${name}」`);
  return true;
}

function toggleBoss(id) {
  const b = state.bosses.find(x => x.id === id);
  if (!b) return;
  b.enabled = !b.enabled;
  save(); render();
}

let editingBossId = null; // 周本管理里的行内编辑
function bossColorIndex(bossId) {
  const i = state.bosses.findIndex(b => b.id === bossId);
  return i < 0 ? 0 : i;
}

/** 声骸按钮短名：共鸣回响·天演溯心 → 天演溯心；共鸣回响·鸣式·利维亚坦 → 利维亚坦 */
function echoShort(echoName) {
  if (!echoName) return "";
  const parts = echoName.split("·");
  return parts[parts.length - 1] || echoName;
}

/* ─────────────── 图标：上传图 > 内置图 > emoji > 🎯 ─────────────── */

let iconManifest = {}; // bossId -> 内置图标文件名（web/assets/boss/manifest.json）

async function loadIconManifest() {
  try {
    const r = await fetch("assets/boss/manifest.json", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    iconManifest = (j && j.icons) || {};
    render(); // 图标到位后重绘（首屏先用 emoji，拿到清单即换真图）
  } catch { /* file:// 直开 / 文件缺失 → emoji 兜底，不打扰用户 */ }
}

function resolveBossIcon(boss) {
  if (boss.icon) return { type: "img", src: boss.icon };
  const f = iconManifest[boss.id];
  if (f) return { type: "img", src: `assets/boss/${f}` };
  return { type: "emoji", text: boss.emoji || "🎯" };
}

/** 生成图标节点（卡片头 / 周本列表 / 历史累计卡 共用，保证三处一致） */
function iconNode(boss, cls) {
  const box = el("div", cls || "card-emoji");
  const r = resolveBossIcon(boss);
  if (r.type === "img") {
    const im = document.createElement("img");
    im.className = "boss-icon-img";
    im.src = r.src;
    im.alt = boss.name;
    box.appendChild(im);
  } else {
    box.textContent = r.text;
  }
  return box;
}

function renderIconPreview(node, icon, emoji) {
  if (!node) return;
  node.textContent = "";
  if (icon) {
    const im = document.createElement("img");
    im.src = icon; im.alt = "图标预览";
    node.appendChild(im);
  } else {
    node.textContent = emoji || "🎯";
  }
}

/** 本地图片 → 居中裁方 + 256×256 → data URL（webp 优先，浏览器不支持则退回 png） */
function processImageFile(file, cb) {
  if (!file || !/^image\//.test(file.type)) { toast("请选择图片文件"); return; }
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    try {
      const S = 256;
      const cv = document.createElement("canvas");
      cv.width = S; cv.height = S;
      const ctx = cv.getContext("2d");
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) { toast("图片尺寸异常"); return; }
      ctx.drawImage(img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, S, S);
      let out = cv.toDataURL("image/webp", 0.85);
      if (!out.startsWith("data:image/webp")) out = cv.toDataURL("image/png"); // Safari 等无 webp 编码
      cb(out);
    } catch { toast("图片处理失败，请换一张试试"); }
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast("图片读取失败，请换一张试试"); };
  img.src = url;
}

/* ───────────────────────── 导入 / 导出 ───────────────────────── */

function exportJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportAll() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  exportJson({ ...state, exportedAt: new Date().toISOString() }, `wuwa-weekly-counter-${stamp}.json`);
  toast("已导出备份");
}

/** 采用一份完整数据（导入 / 云同步下载共用）：迁移 → 清洗 → 回填 → 落库 */
function adoptState(data) {
  migrate(data.version || 1, data);
  for (const w of Object.values(data.weeks || {})) {
    if (w && typeof w === "object") for (const b of Object.values(w)) sanitizeBucket(b);
  }
  for (const t of Object.values(data.totals || {})) sanitizeBucket(t);
  const base = defaultState();
  state = {
    ...base, ...data,
    version: SCHEMA_VERSION,
    settings: { ...base.settings, ...data.settings },
    weeks: data.weeks || {},
    totals: data.totals || {},
    log: Array.isArray(data.log) ? data.log : [],
    bosses: data.bosses.map(b => ({
      id: b.id, name: b.name || b.id, emoji: b.emoji || "🎯",
      echoName: b.echoName || "",
      echoName2: b.echoName2 || "",
      material: b.material || "",
      icon: (typeof b.icon === "string" && b.icon.startsWith("data:image/")) ? b.icon : "",
      aliases: Array.isArray(b.aliases) ? b.aliases : [], enabled: b.enabled !== false,
    })),
  };
  mergeDefaultBosses(state.bosses); // 旧备份缺的新预置周本一并补上
  applyNameFixups(state.bosses);    // 旧备份里的旧名一并修正
  backfillEchoNames(state.bosses);  // 内置声骸名回填
  editMode = false;
  save(); render();
}

function importFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch { toast("导入失败：不是有效的 JSON"); return; }
    if (!data || typeof data !== "object" || !Array.isArray(data.bosses)) {
      toast("导入失败：结构不符（缺少 bosses 列表）"); return;
    }
    if ((data.version ?? 1) > SCHEMA_VERSION) {
      toast(`导入失败：文件版本 ${data.version} 高于应用支持的 ${SCHEMA_VERSION}`); return;
    }
    if (!confirm("导入将【覆盖】当前全部数据。\n\n应用前会自动先下载当前数据的备份。\n确定继续吗？")) return;
    exportAll(); // 强制备份（rules §6）
    adoptState(data);
    toast("导入成功");
  };
  reader.readAsText(file);
}

/* ────────────────── 云同步：GitHub Gist（私有） ────────────────── */

const SYNC_KEY = "wuwa-weekly-counter/gh";   // {token, gistId, pass}：单独存本机，不随导出/同步外泄
const GIST_FILE = "wuwa-weekly-counter.json";
let syncAuth = (() => {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY) || "{}"); } catch { return {}; }
})();
let syncBusy = false;

function saveSyncAuth() {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify({
      token: syncAuth.token || "",
      gistId: syncAuth.gistId || "",
      pass: syncAuth.pass || "",
    }));
  } catch { toast("保存同步配置失败：浏览器存储不可用"); }
}

function refreshSyncStatus() {
  const node = $("#sync-status");
  if (!node) return;
  const t = syncAuth.token ? "Token 已配置" : "未配置 Token";
  const g = syncAuth.gistId ? ` · Gist ${String(syncAuth.gistId).slice(0, 8)}…` : " · 尚无 Gist（上传时自动创建）";
  const auto = syncAuth.auto ? " · 自动同步：开" : " · 自动同步：关";
  const enc = syncAuth.pass
    ? " · 已启用口令加密"
    : (cryptoAvailable() ? " · 未设口令（明文）" : " · 未设口令（此环境不支持加密）");
  const last = state.settings.lastSyncAt
    ? ` · 上次同步：${new Date(state.settings.lastSyncAt).toLocaleString("zh-CN", { hour12: false })}`
    : " · 上次同步：—";
  node.textContent = `${t}${g}${enc}${auto}${last}`;
}

async function ghApi(method, path, body) {
  if (!syncAuth.token) throw new Error("请先填写 GitHub Token");
  let r;
  try {
    r = await fetch("https://api.github.com" + path, {
      method,
      headers: {
        "Authorization": "Bearer " + syncAuth.token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("网络请求失败（离线或被拦截）");
  }
  if (r.status === 401) throw new Error("Token 无效或缺少 gist 权限（401）");
  if (r.status === 404) throw new Error("找不到 Gist，请检查 Gist ID（404）");
  if (!r.ok) {
    let msg = "";
    try { const j = await r.json(); msg = j.message || ""; } catch { /* ignore */ }
    throw new Error(`GitHub API 错误 ${r.status}${msg ? "：" + msg : ""}`);
  }
  return r.json();
}

/* ── 口令加密：Gist 只是"秘密链接"，加密后即便链接泄露也读不到内容 ── */
const SYNC_KDF_ITERATIONS = 250000; // 手机端约 0.3~0.8s

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cryptoAvailable() {
  return !!(window.crypto && window.crypto.subtle && window.isSecureContext);
}

async function deriveSyncKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

/** 上传用的数据体：有口令 → 加密；无口令 → 明文（并提示风险） */
async function buildSyncPayload() {
  const ts = new Date().toISOString();
  const base = { app: "wuwa-weekly-counter", version: SCHEMA_VERSION, ts };
  if (!syncAuth.pass) return { ...base, state };
  if (!cryptoAvailable()) throw new Error("当前环境不支持加密（需 https 或 localhost 下打开）");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveSyncKey(syncAuth.pass, salt, SYNC_KDF_ITERATIONS);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(state))
  );
  return {
    ...base,
    enc: "AES-GCM-256",
    kdf: { name: "PBKDF2-SHA256", iterations: SYNC_KDF_ITERATIONS, salt: bytesToB64(salt) },
    iv: bytesToB64(iv),
    data: bytesToB64(new Uint8Array(cipher)),
  };
}

/** 解密云端数据体；返回 { ts, state } */
async function decryptSyncPayload(p) {
  if (!syncAuth.pass) throw new Error("云端数据已加密，请先在「同步口令」填入口令");
  if (!cryptoAvailable()) throw new Error("当前环境不支持解密（需 https 或 localhost 下打开）");
  if (!p.kdf || !p.kdf.salt || !p.iv || !p.data) throw new Error("加密数据缺少必要字段");
  const key = await deriveSyncKey(syncAuth.pass, b64ToBytes(p.kdf.salt),
    p.kdf.iterations || SYNC_KDF_ITERATIONS);
  let buf;
  try {
    buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(p.iv) }, key, b64ToBytes(p.data));
  } catch {
    throw new Error("口令错误，或云端数据已损坏");
  }
  const st = JSON.parse(new TextDecoder().decode(buf));
  if (!st || !Array.isArray(st.bosses)) throw new Error("解密后的数据格式不对");
  return { ts: p.ts, state: st };
}

async function syncUpload(quiet = false) {
  if (syncBusy) return false;
  syncBusy = true;
  try {
    // 云端已加密而本机未设口令 → 拒绝覆盖，避免把密文冲成明文
    if (syncAuth.gistId && !syncAuth.pass) {
      try {
        const meta = await ghApi("GET", "/gists/" + syncAuth.gistId);
        const f = meta.files && meta.files[GIST_FILE];
        if (f && f.content) {
          const j = JSON.parse(f.content);
          if (j && j.enc) throw new Error("云端数据已加密，本机未设置同步口令，已取消上传（避免覆盖密文）");
        }
      } catch (e) {
        if (String(e && e.message || "").includes("已加密")) throw e;
        // 其他情况（首次上传/网络抖动）忽略，继续上传
      }
    }
    const payload = await buildSyncPayload();
    const files = { [GIST_FILE]: { content: JSON.stringify(payload) } };
    if (!syncAuth.gistId) {
      const created = await ghApi("POST", "/gists", {
        description: "wuwa-weekly-counter 数据（私有备份）",
        public: false,
        files,
      });
      syncAuth.gistId = created.id;
      saveSyncAuth();
      const input = $("#sync-gist");
      if (input) input.value = created.id;
    } else {
      await ghApi("PATCH", "/gists/" + syncAuth.gistId, { files });
    }
    state.settings.lastSyncAt = new Date().toISOString();
    save(); render(); refreshSyncStatus();
    pushedVersion = dirtyVersion;   // 避免自动上传自触发死循环
    if (!quiet) toast(syncAuth.pass ? "已加密上传到云端" : "已上传到云端（明文）");
    return true;
  } catch (e) {
    if (!quiet) toast("上传失败：" + e.message);
    else if (/加密|口令|Token|401/.test(String(e.message))) toast("自动同步失败：" + e.message);
    return false;
  } finally { syncBusy = false; }
}

async function fetchRemote() {
  if (!syncAuth.token) throw new Error("请先填写 GitHub Token");
  if (!syncAuth.gistId) throw new Error("还没有 Gist：先「上传到云端」创建，或填写 Gist ID");
  const g = await ghApi("GET", "/gists/" + syncAuth.gistId);
  const f = g.files && g.files[GIST_FILE];
  if (!f) throw new Error("云端 Gist 里还没有数据文件");
  let text = f.content || "";
  if (f.truncated && f.raw_url) {
    const raw = await fetch(f.raw_url, {
      headers: { "Authorization": "Bearer " + syncAuth.token },
    });
    if (!raw.ok) throw new Error("云端数据过大且无法读取原始文件，请改用「导出/导入 JSON」");
    text = await raw.text();
  }
  let p = JSON.parse(text);
  if (p && p.enc) p = await decryptSyncPayload(p);
  if (!p || !p.state || !Array.isArray(p.state.bosses)) throw new Error("云端数据格式不对");
  return p;
}

async function syncDownload() {
  if (syncBusy) return;
  syncBusy = true;
  try {
    const remote = await fetchRemote();
    const when = new Date(remote.ts).toLocaleString("zh-CN", { hour12: false });
    if (!confirm(`云端数据时间：${when}\n\n将用云端数据【覆盖】本机当前数据（本机数据会先自动下载一份备份）。\n继续吗？`)) return;
    exportAll(); // 覆盖前强制备份本机
    adoptState({ ...remote.state });
    state.settings.lastSyncAt = new Date().toISOString();
    save(); render(); refreshSyncStatus();
    toast("已从云端下载");
  } catch (e) {
    toast("下载失败：" + e.message);
  } finally { syncBusy = false; }
}

/** 双向合并：按 周 × 周本 取两边较大值（保守策略）；totals 由合并后的 weeks 重算 */
function mergeRemoteState(remoteState) {
  // 周本并集（本机已有的以本机为准）
  for (const rb of remoteState.bosses || []) {
    if (!state.bosses.some(b => b.id === rb.id)) {
      state.bosses.push({
        id: rb.id, name: rb.name || rb.id, emoji: rb.emoji || "🎯",
        echoName: rb.echoName || "", echoName2: rb.echoName2 || "", material: rb.material || "",
        icon: "", aliases: Array.isArray(rb.aliases) ? rb.aliases : [], enabled: rb.enabled === true,
      });
    }
  }
  const mergeBucket = (dst, src) => {
    if (!dst || !src) return;
    const mx = f => Math.max(dst[f] || 0, src[f] || 0);
    dst.entries = mx("entries");
    dst.claims = mx("claims");
    dst.echoes1 = mx("echoes1");
    dst.echoes2 = mx("echoes2");
    dst.echoes = dst.echoes1 + dst.echoes2;
  };
  for (const [wid, w] of Object.entries(remoteState.weeks || {})) {
    for (const [bid, rb] of Object.entries(w || {})) {
      mergeBucket(bucket(wid, bid), rb);
    }
  }
  // totals = 合并后各周之和（保证与明细一致）
  for (const boss of state.bosses) {
    const t = { entries: 0, claims: 0, echoes: 0, echoes1: 0, echoes2: 0 };
    for (const w of Object.values(state.weeks)) {
      const b = w[boss.id];
      if (!b) continue;
      t.entries += b.entries || 0;
      t.claims += b.claims || 0;
      t.echoes1 += b.echoes1 || 0;
      t.echoes2 += b.echoes2 || 0;
    }
    t.echoes = t.echoes1 + t.echoes2;
    state.totals[boss.id] = t;
  }
  state.settings.lastSyncAt = new Date().toISOString();
  save(); render(); refreshSyncStatus();
}

/* ───────────────── 自动同步：打开时拉取 + 计数后防抖上传 ───────────────── */

function scheduleAutoPush() {
  if (autoPushTimer) { clearTimeout(autoPushTimer); autoPushTimer = 0; }
  if (typeof syncAuth === "undefined" || !syncAuth || !syncAuth.auto) return;
  if (!syncAuth.token) return;   // 未建 Gist 也允许：首次自动上传会创建
  autoPushTimer = setTimeout(() => { autoPushTimer = 0; autoPush(); }, 4000);
}

async function autoPush() {
  if (!syncAuth.auto || !syncAuth.token || syncBusy) return;
  if (pushedVersion >= dirtyVersion) return;
  const startedAt = dirtyVersion;
  const ok = await syncUpload(true);
  if (ok) pushedVersion = startedAt;
}

/** 打开时从云端合并（保守 max 合并，不会覆盖本机更新的计数） */
async function autoPullOnStartup() {
  if (!syncAuth.auto || !syncAuth.token || !syncAuth.gistId) return;
  try {
    const before = JSON.stringify({ w: state.weeks, t: state.totals });
    const remote = await fetchRemote();
    mergeRemoteState(remote.state);
    const after = JSON.stringify({ w: state.weeks, t: state.totals });
    if (before !== after) toast("已从云端合并最新数据");
  } catch (e) {
    // 离线 / 口令未填 / 云端无数据：静默跳过，不影响本地使用
  }
}

async function syncMerge() {
  if (syncBusy) return;
  syncBusy = true;
  try {
    const remote = await fetchRemote();
    const when = new Date(remote.ts).toLocaleString("zh-CN", { hour12: false });
    if (!confirm(`云端数据时间：${when}\n\n将把云端与本机数据【双向合并】：\n· 按「周 × 周本」取两边较大计数（撤销过的减少量不会同步回退）\n· 本机没有的周本会从云端补入\n\n合并前会自动下载本机备份。继续？`)) return;
    exportAll();
    mergeRemoteState(remote.state);
    toast("已合并云端数据");
  } catch (e) {
    toast("合并失败：" + e.message);
  } finally { syncBusy = false; }
}

/* ───────────────────────── 渲染 ───────────────────────── */

const $ = sel => document.querySelector(sel);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

let view = "week";

function render() {
  renderWeekHeader();
  if (view === "week") renderWeek();
  else if (view === "history") { renderHistory(); renderChart(); }
  else if (view === "bosses") renderBossList();
  syncSettingsInputs();
  refreshSyncStatus();
}

function renderWeekHeader() {
  const wid = currentWeekId();
  $("#week-id").textContent = wid;
  $("#week-range").textContent = weekRangeText(wid);
  const boundary = weekBoundary();
  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  $("#week-label").textContent =
    `当前 ${wid} · 重置：周${WD[boundary.getDay()]} ${String(state.settings.resetHour).padStart(2, "0")}:00`;

  const nr = nextReset();
  const ms = nr - new Date();
  const days = Math.floor(ms / 86400000);
  const hrs = Math.floor((ms % 86400000) / 3600000);
  $("#reset-countdown").textContent = `距重置 ${days}天${hrs}小时`;

  renderClaimBanner(wid);

  $("#btn-undo").disabled = state.log.length === 0;
  $("#edit-hint").hidden = !editMode;
  $("#btn-edit").hidden = editMode;
}

/** 全局共享领奖进度（rules §3） */
function renderClaimBanner(wid) {
  const limit = state.settings.weeklyClaimLimit;
  const used = weekClaimTotal(wid);
  const pipsBox = $("#claim-pips");
  const badge = $("#claim-badge");
  pipsBox.textContent = "";
  badge.textContent = "";
  badge.className = "";

  if (limit <= 0) {
    $("#claim-text").textContent = `${used} 次`;
    badge.appendChild(el("span", "badge off", "提醒已关"));
    return;
  }
  $("#claim-text").textContent = `${used} / ${limit}`;

  const state_ = used >= limit ? "full" : (used === limit - 1 ? "warn" : "done");
  if (limit <= 8) {
    for (let i = 0; i < limit; i++)
      pipsBox.appendChild(el("span", "pip" + (i < used ? " " + state_ : "")));
  }
  if (used >= limit) badge.appendChild(el("span", "badge full", "本周领奖已满"));
  else if (used === limit - 1) badge.appendChild(el("span", "badge warn", `还剩 1 次`));
  else badge.appendChild(el("span", "badge off", `还剩 ${limit - used} 次`));
}

function statBox(value, label, sub, bossId, field, subLines) {
  const s = el("div", "stat" + (editMode ? " editing" : ""));
  if (editMode && bossId) {
    const inp = el("input", "stat-input");
    inp.type = "number"; inp.min = "0"; inp.step = "1";
    inp.value = String(value);
    inp.setAttribute("aria-label", label);
    inp.addEventListener("change", e => {
      setWeekValue(bossId, field, e.target.value);
      render(); // 重算累计/横幅
    });
    s.appendChild(inp);
  } else {
    s.appendChild(el("b", null, String(value)));
  }
  s.appendChild(el("span", null, label));
  if (subLines && subLines.length) {
    for (const line of subLines) s.appendChild(el("span", "total-sub", line));
  } else if (sub) {
    s.appendChild(el("span", "total-sub", sub));
  }
  return s;
}

function renderWeek() {
  const wrap = $("#boss-cards");
  wrap.textContent = "";
  const wid = currentWeekId();

  for (const boss of state.bosses.filter(b => b.enabled)) {
    const w = (state.weeks[wid] && state.weeks[wid][boss.id]) || { entries: 0, claims: 0, echoes: 0 };
    const t = state.totals[boss.id] || { entries: 0, claims: 0, echoes: 0 };

    const card = el("article", "card");
    card.dataset.boss = boss.id;

    // 头部：图标 + 标题/别名
    const head = el("div", "card-head");
    head.appendChild(iconNode(boss));
    const titles = el("div");
    titles.appendChild(el("h3", "card-title", boss.name));
    if (boss.aliases && boss.aliases.length) titles.appendChild(el("p", "card-alias", boss.aliases.join(" · ")));
    head.appendChild(titles);
    card.appendChild(head);

    // 声骸绑定行（具体 COST4 声骸名；双声骸周本两个都展示，按钮只计主声骸）
    const echoLine = el("p", "echo-name");
    if (boss.echoName) {
      echoLine.appendChild(el("span", null, "COST4 声骸"));
      echoLine.appendChild(el("b", null, boss.echoName));
      if (boss.echoName2) {
        echoLine.appendChild(el("span", null, "/"));
        echoLine.appendChild(el("b", null, boss.echoName2));
      }
    } else {
      echoLine.appendChild(el("span", null, "未设置声骸名（周本页可补填）"));
    }
    card.appendChild(echoLine);

    // 三个统计
    const stats = el("div", "stats" + (boss.echoName2 ? " dual" : ""));
    stats.appendChild(statBox(w.entries, "本周进本", `累计 ${t.entries}`, boss.id, "entries"));
    stats.appendChild(statBox(w.claims,  "本周领奖", `累计 ${t.claims}`,  boss.id, "claims"));
    if (boss.echoName2) {
      // 双声骸：大数字 = 两只声骸本周合计掉落，副行 = 各自累计
      stats.appendChild(statBox(
        w.echoes, "本周声骸", null, boss.id, "echoes",
        [
          `累计 ${echoShort(boss.echoName)} ${t.echoes1 || 0}`,
          `累计 ${echoShort(boss.echoName2)} ${t.echoes2 || 0}`,
        ]
      ));
    } else {
      stats.appendChild(statBox(w.echoes, "本周声骸", `累计 ${t.echoes}`, boss.id, "echoes"));
    }
    card.appendChild(stats);

    // 技能升级材料行：每次领奖 ×3；累计 = 累计领奖 × 3
    if (boss.material) {
      const mat = el("p", "mat-line");
      mat.appendChild(el("span", "mat-label", "技能材料"));
      mat.appendChild(el("b", null, boss.material));
      mat.appendChild(el("span", "mat-rate", "×3/领奖"));
      mat.appendChild(el("span", "mat-total", `累计 ${(t.claims || 0) * 3} 个`));
      card.appendChild(mat);
    }

    // 数据异常警告
    const warns = el("div", "card-warn");
    if ((w.echoes || 0) > (w.entries || 0))
      warns.appendChild(el("span", "badge warn", "⚠ 声骸 > 进本，数据可能有误"));
    else if ((w.claims || 0) > (w.entries || 0))
      warns.appendChild(el("span", "badge warn", "⚠ 领奖 > 进本，数据可能有误"));
    if (warns.children.length) card.appendChild(warns);

    // 按钮：单声骸 =（进本整行）+（领奖|声骸）；双声骸 = 2×2 网格（进本|领奖 / 声骸1|声骸2）
    const stack = el("div", "btn-stack");
    const mkBtn = (cls, text, title, type) => {
      const b = el("button", "btn " + cls, text);
      b.type = "button"; b.disabled = editMode;
      if (title) b.title = title;
      b.onclick = () => addCount(boss.id, type);
      return b;
    };

    if (boss.echoName2) {
      const grid = el("div", "btn-grid2");
      grid.appendChild(mkBtn("btn-primary", "＋1 进本", "记录一次进本", "entry"));
      grid.appendChild(mkBtn("btn-ok", "＋1 领奖", "记录一次领奖", "claim"));
      grid.appendChild(mkBtn("btn-gold", `＋1 ${echoShort(boss.echoName) || "声骸"}`, `记录掉落：${boss.echoName}`, "echo"));
      grid.appendChild(mkBtn("btn-gold", `＋1 ${echoShort(boss.echoName2)}`, `记录掉落：${boss.echoName2}`, "echo2"));
      stack.appendChild(grid);
    } else {
      stack.appendChild(mkBtn("btn-primary btn-entry-main", "＋1 进本", "记录一次进本", "entry"));
      const pair = el("div", "btn-pair");
      pair.appendChild(mkBtn("btn-ok", "＋1 领奖", "记录一次领奖", "claim"));
      const short = echoShort(boss.echoName);
      pair.appendChild(mkBtn("btn-gold", short ? `＋1 ${short}` : "＋1 声骸",
        boss.echoName ? `记录掉落：${boss.echoName}` : "记录 COST4 声骸掉落", "echo"));
      stack.appendChild(pair);
    }

    if (editMode) { stack.classList.add("btn-mute"); }
    card.appendChild(stack);

    attachLongPress(card);

    wrap.appendChild(card);
  }

  if (!wrap.children.length) {
    wrap.appendChild(el("p", "muted", "没有启用中的周本 —— 到「周本」页添加一个吧。"));
  }
}

/* ── 长按进入编辑模式 ── */
function attachLongPress(card) {
  let timer = 0, fired = false, pressEl = null;
  const start = e => {
    if (editMode) return;
    if (e.target.closest("button") || e.target.closest("input")) return;
    pressEl = e.target.closest(".card") || card;
    pressEl.classList.add("pressing");
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      pressEl && pressEl.classList.remove("pressing");
      enterEdit();
    }, LONGPRESS_MS);
  };
  const cancel = () => {
    clearTimeout(timer);
    pressEl && pressEl.classList.remove("pressing");
    pressEl = null;
    if (fired) {
      fired = false;
      // 吞掉长按结束后的那一次 click，防止误触按钮
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); document.removeEventListener("click", swallow, true); };
      document.addEventListener("click", swallow, true);
      setTimeout(() => document.removeEventListener("click", swallow, true), 400);
    }
  };
  card.addEventListener("pointerdown", start);
  card.addEventListener("pointerup", cancel);
  card.addEventListener("pointercancel", cancel);
  card.addEventListener("pointerleave", cancel);
  card.addEventListener("contextmenu", e => { if (!editMode) e.preventDefault(); });
}

/* ───────────────────────── 历史视图 ───────────────────────── */

function renderHistory() {
  // 1) 累计卡片
  const tot = $("#history-totals");
  tot.textContent = "";
  for (const boss of state.bosses) {
    const t = state.totals[boss.id];
    // 只展示有记录（非全零）的周本，避免同步/合并后一堆 0 卡片
    if (!t || (!t.entries && !t.claims && !t.echoes)) continue;
    const card = el("article", "card");
    const head = el("div", "card-head");
    head.appendChild(iconNode(boss));
    const titles = el("div");
    titles.appendChild(el("h3", "card-title", boss.name));
    titles.appendChild(el("p", "card-alias", boss.enabled ? "历史累计" : "已停用 · 历史累计"));
    head.appendChild(titles);
    card.appendChild(head);
    const stats = el("div", "stats");
    stats.appendChild(statBox(t.entries, "累计进本"));
    stats.appendChild(statBox(t.claims,  "累计领奖"));
    if (boss.echoName2) {
      // 双声骸：合计 + 各自累计
      stats.appendChild(statBox(t.echoes ?? 0, "累计声骸", null, null, null, [
        `${echoShort(boss.echoName)} ${t.echoes1 || 0}`,
        `${echoShort(boss.echoName2)} ${t.echoes2 || 0}`,
      ]));
    } else {
      stats.appendChild(statBox(t.echoes ?? 0, "累计声骸"));
    }
    card.appendChild(stats);
    if (boss.material) {
      const mat = el("p", "mat-line");
      mat.appendChild(el("span", "mat-label", "技能材料"));
      mat.appendChild(el("b", null, boss.material));
      mat.appendChild(el("span", "mat-rate", "×3/领奖"));
      mat.appendChild(el("span", "mat-total", `累计 ${(t.claims || 0) * 3} 个`));
      card.appendChild(mat);
    }
    tot.appendChild(card);
  }
  if (!tot.children.length) tot.appendChild(el("p", "muted", "还没有任何记录。"));

  // 2) 每周明细表 —— 转置布局：行 = 周本（真图标），列 = 各周（最近的在左）+ 历史合计
  const table = $("#history-table");
  table.textContent = "";
  const weekIds = Object.keys(state.weeks).sort().reverse();
  const rows = sortBossList(state.bosses);
  if (!weekIds.length) {
    const tbody = el("tbody"), tr = el("tr");
    tr.appendChild(el("td", "muted", "暂无历史周数据"));
    tbody.appendChild(tr); table.appendChild(tbody);
    return;
  }

  const thead = el("thead"), htr = el("tr");
  htr.appendChild(el("th", "corner", "周本 ＼ 周"));
  for (const wid of weekIds) {
    const th = el("th", "week-col");
    th.appendChild(el("div", "wk-id", wid));
    th.appendChild(el("div", "wk-range", weekRangeText(wid)));
    htr.appendChild(th);
  }
  htr.appendChild(el("th", "sum-col", "历史合计"));
  thead.appendChild(htr); table.appendChild(thead);

  const tbody = el("tbody");
  for (const boss of rows) {
    const tr = el("tr");
    const th = el("th", "row-head");
    th.appendChild(iconNode(boss, "row-icon"));
    const nameBox = el("div", "row-name");
    nameBox.appendChild(el("span", null, boss.name));
    if (!boss.enabled) nameBox.appendChild(el("span", "badge off", "停用"));
    th.appendChild(nameBox);
    tr.appendChild(th);

    for (const wid of weekIds) {
      tr.appendChild(statCell((state.weeks[wid] || {})[boss.id]));
    }
    tr.appendChild(statCell(state.totals[boss.id], "num sum-col"));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  initTableScroll();
}

/** 明细表横向滚动控制条：手机/窄屏下列多、表格超宽，用滑块 + 左右按钮替代"盲拖" */
function initTableScroll() {
  const table = $("#history-table");
  if (!table) return;
  const wrap = table.closest(".table-wrap");
  const bar = $("#table-scroll");
  const range = $("#table-range");
  const hint = $("#table-scroll-hint");
  if (!wrap || !bar || !range) return;

  const max = Math.max(0, table.scrollWidth - wrap.clientWidth);
  const need = max > 4;
  bar.hidden = !need;
  if (hint) hint.hidden = !need;

  range.max = String(Math.max(0, max));
  range.value = String(Math.min(max, Math.max(0, wrap.scrollLeft)));

  if (!wrap.dataset.scrollBound) {
    wrap.dataset.scrollBound = "1";
    wrap.addEventListener("scroll", () => {
      range.value = String(wrap.scrollLeft);
    }, { passive: true });
    range.addEventListener("input", () => { wrap.scrollLeft = Number(range.value); });
    const left = $("#scroll-left"), right = $("#scroll-right");
    if (left) left.onclick = () => wrap.scrollBy({ left: -Math.round(wrap.clientWidth * 0.7), behavior: "smooth" });
    if (right) right.onclick = () => wrap.scrollBy({ left: Math.round(wrap.clientWidth * 0.7), behavior: "smooth" });
  }
}

/** 明细表单元格：三个数字带单位标注（0进本 / 0领奖 / 0声骸），缺失显示「–」 */
function statCell(v, cls) {
  const td = el("td", "num" + (cls ? " " + cls : ""));
  if (!v) { td.textContent = "–"; return td; }
  const tri = [
    [v.entries || 0, "进本", "e"],
    [v.claims || 0, "领奖", "c"],
    [v.echoes || 0, "声骸", "h"],
  ];
  tri.forEach(([n, unit, kind], i) => {
    const seg = el("span", "tri");
    seg.appendChild(el("b", "v-" + kind, String(n)));
    seg.appendChild(el("span", "unit", unit));
    td.appendChild(seg);
    if (i < 2) td.appendChild(el("span", "sep", "/"));
  });
  return td;
}

/* ───────────────────────── 趋势图（每周进本） ───────────────────────── */

function renderChart() {
  const canvas = $("#trend-chart");
  const legend = $("#chart-legend");
  const card = $("#chart-card");
  let empty = card.querySelector(".chart-empty");
  if (!empty) { empty = el("div", "chart-empty"); empty.hidden = true; card.insertBefore(empty, canvas); }

  const allWeeks = Object.keys(state.weeks).sort();
  const weeks = allWeeks.slice(-CHART_MAX_WEEKS);

  // 收集有数据的 boss（图例用）
  const bossData = state.bosses.map(boss => ({
    id: boss.id, name: boss.name, emoji: boss.emoji, enabled: boss.enabled,
    color: CHART_COLORS[bossColorIndex(boss.id) % CHART_COLORS.length],
    values: weeks.map(w => (state.weeks[w][boss.id] && state.weeks[w][boss.id].entries) || 0),
  }));
  const visible = bossData.filter(b => b.values.some(v => v > 0));
  const hasData = visible.length > 0;

  legend.textContent = "";
  if (!hasData) {
    canvas.hidden = true;
    empty.hidden = false;
    empty.textContent = "暂无数据 —— 到「本周」页打几把再来";
    return;
  }
  canvas.hidden = false;
  empty.hidden = true;

  for (const b of visible) {
    const key = el("span", "key");
    const sw = el("span", "swatch"); sw.style.background = b.color;
    key.appendChild(sw);
    const boss = state.bosses.find(x => x.id === b.id);
    const r = resolveBossIcon(boss);
    if (r.type === "img") {
      const im = document.createElement("img");
      im.className = "legend-icon"; im.src = r.src; im.alt = "";
      key.appendChild(im);
    } else {
      key.appendChild(el("span", null, r.text));
    }
    key.appendChild(el("span", null, b.name));
    legend.appendChild(key);
  }

  // 画布（DPR 适配）
  const cssW = canvas.parentElement.clientWidth - 52; // 卡片左右 padding
  const cssH = 250;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, cssW) * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const W = Math.max(320, cssW), H = cssH;

  const cs = getComputedStyle(document.documentElement);
  const muted = cs.getPropertyValue("--muted").trim() || "#888";
  const border = cs.getPropertyValue("--border").trim() || "#ccc";
  ctx.clearRect(0, 0, W, H);
  ctx.font = '12.5px "Segoe UI", "Microsoft YaHei", sans-serif';

  const padL = 34, padR = 8, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const maxV = Math.max(...visible.flatMap(b => b.values), 1);
  // 取偶数上限，保证 0 / ½ / 1 三个刻度都是整数（计数类数据不出现 2.5 这种刻度）
  const niceMax = maxV <= 4 ? 4 : Math.ceil(maxV / 4) * 4;

  // 网格线 + y 轴刻度
  ctx.strokeStyle = border;
  ctx.fillStyle = muted;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 2; i++) {
    const v = niceMax * i / 2;
    const y = padT + plotH - (v / niceMax) * plotH;
    ctx.globalAlpha = i === 0 ? 1 : .5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(String(v), padL - 7, y);
  }

  const groupW = plotW / weeks.length;
  const barsInGroup = visible.length;
  const barW = Math.min(26, (groupW - 14) / barsInGroup);
  const groupInner = barW * barsInGroup;

  weeks.forEach((wid, wi) => {
    const gx = padL + wi * groupW + (groupW - groupInner) / 2;
    visible.forEach((b, bi) => {
      const v = b.values[wi];
      const h = (v / niceMax) * plotH;
      const x = gx + bi * barW;
      const y = padT + plotH - h;
      ctx.fillStyle = b.color;
      ctx.globalAlpha = b.enabled ? 1 : .4;
      const r = Math.min(4, barW / 2 - 1, Math.max(0, h - 1));
      if (h > 0) {
        ctx.beginPath();
        ctx.moveTo(x, y + h);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.lineTo(x + barW - r, y);
        ctx.arcTo(x + barW, y, x + barW, y + r, r);
        ctx.lineTo(x + barW, y + h);
        ctx.closePath();
        ctx.fill();
        if (barW >= 14 && groupW > 40) {
          ctx.fillStyle = muted;
          ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillText(String(v), x + barW / 2, y - 3);
          ctx.fillStyle = b.color;
        }
      }
      ctx.globalAlpha = 1;
    });
    // x 轴标签：W42
    ctx.fillStyle = muted;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(wid.slice(5), padL + wi * groupW + groupW / 2, padT + plotH + 7);
  });
}

/* ───────────────────────── 周本管理 ───────────────────────── */

function renderBossList() {
  const wrap = $("#boss-list");
  wrap.textContent = "";
  // 排序：启用的在前、停用的在后；组内按周本名拼音字母序（同音跨字按后续音节比较）
  const sorted = sortBossList(state.bosses);
  for (const boss of sorted) {
    const item = el("div", "boss-item" + (boss.enabled ? "" : " disabled"));

    if (editingBossId === boss.id) {
      // 行内编辑：名称 + 声骸名 + 图标（emoji / 本地图片）
      let pendingIcon = boss.icon || "";
      const editBox = el("div", "boss-edit");

      const row1 = el("label", null, "周本名称");
      const inName = document.createElement("input");
      inName.value = boss.name; inName.maxLength = 40;
      row1.appendChild(inName);

      const row2 = el("label", null, "声骸名（COST4，双声骸周本可再填第二个）");
      const inEcho = document.createElement("input");
      inEcho.value = boss.echoName || ""; inEcho.maxLength = 40;
      inEcho.placeholder = "例：共鸣回响·天演溯心";
      row2.appendChild(inEcho);
      const inEcho2 = document.createElement("input");
      inEcho2.value = boss.echoName2 || ""; inEcho2.maxLength = 40;
      inEcho2.placeholder = "第二个声骸（可空），例：共鸣回响·达妮娅";
      inEcho2.style.marginTop = "8px";
      row2.appendChild(inEcho2);
      const row3 = el("label", null, "技能升级材料（每次领奖 ×3，可空）");
      const inMat = document.createElement("input");
      inMat.value = boss.material || ""; inMat.maxLength = 40;
      inMat.placeholder = "例：演轮残蜕";
      row3.appendChild(inMat);

      // 图标块：预览 + emoji + 选图/清除
      const iconBlock = el("div", "field-block");
      iconBlock.appendChild(el("span", "field-label", "图标"));
      const iconField = el("div", "icon-field");
      const prev = el("div", "icon-preview");
      const controls = el("div", "icon-controls");
      const emojiLabel = el("label", null, "emoji（可空）");
      const inEmoji = document.createElement("input");
      inEmoji.value = boss.emoji || ""; inEmoji.maxLength = 4; inEmoji.placeholder = "🎼";
      emojiLabel.appendChild(inEmoji);
      const btnBox = el("div", "icon-buttons");
      const pickBtn = el("button", "btn mini-btn", "🖼 选择本地图片"); pickBtn.type = "button";
      const clearBtn = el("button", "btn mini-btn", "清除图片"); clearBtn.type = "button";
      const fileInput = document.createElement("input");
      fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.hidden = true;
      const refreshIcon = () => {
        renderIconPreview(prev, pendingIcon, inEmoji.value.trim());
        clearBtn.hidden = !pendingIcon;
      };
      pickBtn.onclick = () => fileInput.click();
      fileInput.onchange = e => {
        const f = e.target.files && e.target.files[0];
        if (f) processImageFile(f, data => { pendingIcon = data; refreshIcon(); });
        e.target.value = "";
      };
      clearBtn.onclick = () => { pendingIcon = ""; refreshIcon(); };
      inEmoji.addEventListener("input", refreshIcon);
      btnBox.append(pickBtn, clearBtn);
      controls.append(emojiLabel, btnBox, fileInput);
      iconField.append(prev, controls);
      iconBlock.appendChild(iconField);
      refreshIcon();

      editBox.append(row1, row2, row3, iconBlock);

      const btnRow = el("div", "btn-row");
      const saveBtn = el("button", "btn btn-primary mini-btn", "保存");
      saveBtn.type = "button";
      saveBtn.onclick = () => {
        const n = inName.value.trim();
        if (!n) { toast("名称不能为空"); return; }
        boss.name = n;
        boss.echoName = inEcho.value.trim();
        boss.echoName2 = inEcho2.value.trim();
        boss.material = inMat.value.trim();
        boss.emoji = inEmoji.value.trim() || "🎯";
        boss.icon = pendingIcon;
        editingBossId = null;
        save(); render();
        toast("已保存");
      };
      const cancelBtn = el("button", "btn mini-btn", "取消");
      cancelBtn.type = "button";
      cancelBtn.onclick = () => { editingBossId = null; render(); };
      btnRow.append(saveBtn, cancelBtn);
      editBox.appendChild(btnRow);

      item.appendChild(editBox);
      wrap.appendChild(item);
      continue;
    }

    const main = el("div", "boss-main");
    main.appendChild(iconNode(boss));

    const grow = el("div", "grow");
    grow.appendChild(el("div", "name", boss.name));
    grow.appendChild(el("div", "id", boss.id + (boss.aliases && boss.aliases.length ? ` · ${boss.aliases.join(" / ")}` : "")));
    const echoTag = el("div", "echo-tag");
    if (boss.echoName) {
      echoTag.appendChild(document.createTextNode("声骸："));
      echoTag.appendChild(el("b", null, boss.echoName));
      if (boss.echoName2) {
        echoTag.appendChild(document.createTextNode(" / "));
        echoTag.appendChild(el("b", null, boss.echoName2));
      }
    }
    grow.appendChild(echoTag);
    main.appendChild(grow);
    item.appendChild(main);

    // 操作区：计数徽章单独一行（如有），「编辑 + 启用/停用」始终同一行
    const actions = el("div", "boss-actions");
    const t = state.totals[boss.id];
    if (t) actions.appendChild(el("span", "badge off", `${t.entries || 0}进本 / ${t.claims || 0}领奖 / ${t.echoes || 0}声骸`));

    const btns = el("div", "boss-btns");
    const editBtn = el("button", "btn mini-btn", "✎ 编辑");
    editBtn.type = "button";
    editBtn.onclick = () => { editingBossId = boss.id; render(); };
    btns.appendChild(editBtn);

    const btn = el("button", "btn mini-btn", boss.enabled ? "停用" : "启用");
    btn.type = "button"; btn.onclick = () => toggleBoss(boss.id);
    btns.appendChild(btn);
    actions.appendChild(btns);
    item.appendChild(actions);

    wrap.appendChild(item);
  }
}

function syncSettingsInputs() {
  const pairs = [
    ["#set-weekday", String(state.settings.resetWeekday)],
    ["#set-hour", String(state.settings.resetHour)],
    ["#set-limit", String(state.settings.weeklyClaimLimit)],
  ];
  for (const [sel, val] of pairs) {
    const node = $(sel);
    if (node && document.activeElement !== node && node.value !== val) node.value = val;
  }
}

/* ───────────────────────── Toast ───────────────────────── */
let toastTimer = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

/* ───────────────────────── 事件绑定 ───────────────────────── */

/* ───────────── 标签页切换（点击与 Android 返回键共用） ───────────── */

function switchView(name) {
  view = name;
  if (view !== "week" && editMode) { editMode = false; }
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => { v.hidden = v.id !== `view-${view}`; });
  render();
  window.scrollTo({ top: 0 });
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => switchView(tab.dataset.view);
}

$("#btn-undo").onclick = undo;
$("#btn-edit").onclick = enterEdit;
$("#btn-edit-done").onclick = exitEdit;

// 主题
const THEME_KEY = "wuwa-weekly-counter/theme";
function applyTheme(mode) {
  if (mode) document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  const dark = mode === "dark" || (!mode && matchMedia("(prefers-color-scheme: dark)").matches);
  $("#btn-theme").textContent = dark ? "☀️" : "🌙";
}
applyTheme(localStorage.getItem(THEME_KEY) || "");
$("#btn-theme").onclick = () => {
  const cur = localStorage.getItem(THEME_KEY) || "";
  const nowDark = cur === "dark" || (!cur && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = nowDark ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  if (view === "history") renderChart(); // 颜色跟随主题
};

// ── 新增周本：图标（emoji + 本地图片） ──
let newIcon = ""; // 待提交的自定义图标 data URL
function refreshNewIconPreview() {
  renderIconPreview($("#new-icon-preview"), newIcon, $("#boss-emoji").value.trim());
  $("#btn-new-icon-clear").hidden = !newIcon;
}
$("#boss-emoji").addEventListener("input", refreshNewIconPreview);
$("#btn-new-icon").onclick = () => $("#new-icon-file").click();
$("#new-icon-file").onchange = e => {
  const f = e.target.files && e.target.files[0];
  if (f) processImageFile(f, data => { newIcon = data; refreshNewIconPreview(); toast("已选择图标图片"); });
  e.target.value = "";
};
$("#btn-new-icon-clear").onclick = () => { newIcon = ""; refreshNewIconPreview(); };

// 周本添加
$("#boss-form").onsubmit = e => {
  e.preventDefault();
  const name = $("#boss-name").value.trim();
  if (!name) return;
  const echoName = $("#boss-echo").value.trim();
  const echoName2 = $("#boss-echo2").value.trim();
  const material = $("#boss-material").value.trim();
  const emoji = $("#boss-emoji").value.trim();
  const aliases = $("#boss-aliases").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (addBoss(name, echoName, echoName2, material, emoji, aliases, newIcon)) {
    $("#boss-name").value = ""; $("#boss-echo").value = ""; $("#boss-echo2").value = "";
    $("#boss-material").value = ""; $("#boss-emoji").value = ""; $("#boss-aliases").value = "";
    newIcon = ""; refreshNewIconPreview();
  }
};

// 设置
$("#set-weekday").onchange = e => { state.settings.resetWeekday = +e.target.value; save(); render(); };
$("#set-hour").onchange = e => {
  state.settings.resetHour = Math.min(23, Math.max(0, +e.target.value || 0)); save(); render();
};
$("#set-limit").onchange = e => {
  state.settings.weeklyClaimLimit = Math.min(99, Math.max(0, +e.target.value || 0)); save(); render();
};

// 云同步 · GitHub Gist
$("#sync-token").value = syncAuth.token || "";
$("#sync-gist").value = syncAuth.gistId || "";
$("#sync-pass").value = syncAuth.pass || "";
$("#sync-pass").onchange = e => {
  syncAuth.pass = e.target.value; saveSyncAuth(); refreshSyncStatus();
  if (syncAuth.pass) toast("已启用口令加密：下次上传将加密");
};
$("#sync-auto").checked = !!syncAuth.auto;
$("#sync-auto").onchange = e => {
  syncAuth.auto = !!e.target.checked; saveSyncAuth(); refreshSyncStatus();
  toast(syncAuth.auto ? "已开启自动同步" : "已关闭自动同步");
};
$("#sync-token").onchange = e => {
  syncAuth.token = e.target.value.trim(); saveSyncAuth(); refreshSyncStatus();
};
$("#sync-gist").onchange = e => {
  syncAuth.gistId = e.target.value.trim(); saveSyncAuth(); refreshSyncStatus();
};
$("#btn-sync-up").onclick = syncUpload;
$("#btn-sync-down").onclick = syncDownload;
$("#btn-sync-merge").onclick = syncMerge;

// 数据
$("#btn-export").onclick = exportAll;
$("#btn-import").onclick = () => $("#file-import").click();
$("#file-import").onchange = e => {
  const f = e.target.files && e.target.files[0];
  if (f) importFile(f);
  e.target.value = "";
};
$("#btn-clear").onclick = () => {
  if (!confirm("确定清空全部计数与历史？\n（建议先导出备份）")) return;
  if (!confirm("再次确认：此操作不可恢复！")) return;
  state = defaultState();
  editMode = false;
  save(); render();
  toast("已清空");
};

// 窗口尺寸变化 → 重画趋势图
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (view === "history") { renderChart(); initTableScroll(); } }, 150);
});

/* 调试句柄：仅在 ?debug=1 时暴露，方便本地验证自动同步等内部逻辑 */
if (new URLSearchParams(location.search).get("debug") === "1") {
  window.__wwc = { autoPullOnStartup, mergeRemoteState, fetchRemote, syncUpload, getAuth: () => ({ hasToken: !!syncAuth.token, gistId: syncAuth.gistId || "", auto: !!syncAuth.auto, hasPass: !!syncAuth.pass }), setAuto: v => { syncAuth.auto = v; } };
}
/* ───────────── Android 客户端适配（仅 Capacitor 环境生效，网页版零影响） ───────────── */

const NATIVE_PLUGINS = (window.Capacitor
  && typeof window.Capacitor.isNativePlatform === "function"
  && window.Capacitor.isNativePlatform()
  && window.Capacitor.Plugins) || null;

if (NATIVE_PLUGINS) {
  document.documentElement.classList.add("native");

  // 状态栏：深色背景 + 浅色图标
  if (NATIVE_PLUGINS.StatusBar) {
    NATIVE_PLUGINS.StatusBar.setStyle({ style: "DARK" }).catch(() => {});
    NATIVE_PLUGINS.StatusBar.setBackgroundColor({ color: "#14161d" }).catch(() => {});
  }

  // 返回键：编辑模式 → 退编辑；非本周页 → 回本周；否则最小化（不直接退出，避免误杀）
  const appPlugin = NATIVE_PLUGINS.App;
  if (appPlugin && appPlugin.addListener) {
    appPlugin.addListener("backButton", () => {
      if (editMode) { editMode = false; render(); return; }
      if (view !== "week") { switchView("week"); return; }
      if (appPlugin.minimizeApp) appPlugin.minimizeApp();
    });
  }

  // 启动闪屏：首帧渲染后隐藏
  if (NATIVE_PLUGINS.SplashScreen) {
    setTimeout(() => NATIVE_PLUGINS.SplashScreen.hide().catch(() => {}), 250);
  }
}

// 关于页：显示版本与运行形态（网页版 / Android 客户端）
(function fillAboutVersion() {
  const node = document.getElementById("about-version");
  if (!node) return;
  const native = document.documentElement.classList.contains("native");
  node.textContent = `v${APP_VERSION}（${BUILD_DATE}）· ${native ? "Android 客户端" : "网页版"}`;
})();
/* ───────────────────────── 启动 ───────────────────────── */

render();
refreshNewIconPreview();          // 表单图标预览初始态（🎯）
loadIconManifest();               // 拉取内置图标清单（异步，到位后自动重绘）
autoPullOnStartup();              // 自动同步：打开即从云端合并（未开启则立即返回）

// 每分钟刷新倒计时/周界（跨过重置点时自动滚周）；编辑模式下不重建卡片，避免打断输入
setInterval(() => {
  renderWeekHeader();
  if (view === "week" && !editMode) renderWeek();
}, 60000);

// PWA：仅在 http(s) 下注册 Service Worker（file:// 直接打开不注册，功能不受影响）
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

})();
