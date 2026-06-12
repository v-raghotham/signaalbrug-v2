/* SignaalBrug v2 — data layer.
   Local-first store (localStorage) with pub/sub, domain logic, demo crypto,
   and an optional Firestore mirror (env-config or runtime "paste config" switch).

   Re-render contract: the store mutates `db` in place, so subscribers must read
   SBStore.version (incremented on every notify) as their useSyncExternalStore
   snapshot — never the object reference, or React bails out on identical
   snapshots and toggles appear dead. */

import { makeSeed } from "../data/seed";
import { getAi, aiLabel } from "../ai/adapter";

const LS_KEY = "sb2.db.v2";
const LS_SESSION = "sb2.session.v2";

const listeners = new Set();
let db = null;

/* ---------- persistence ---------- */
function freshDb() {
  return {
    ...makeSeed(),
    settings: {
      aiProvider: import.meta.env.VITE_AI_PROVIDER || "mock",
      dataSource: "local",
      firebaseConfig: "",
    },
    helpDismissed: {},
  };
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { db = JSON.parse(raw); return; }
  } catch { /* corrupted → reseed */ }
  db = freshDb();
  save();
}

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch { /* quota/private mode */ }
}

function notify() {
  SBStore.version++;
  listeners.forEach((fn) => fn(db));
}

function replaceFromRemote(data) {
  Object.assign(db, data);
  save();
  notify();
}

export const SBStore = {
  version: 0,
  get: () => db,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  update(mutator) { mutator(db); save(); notify(); if (!fb._applyingRemote) fb.mirror(); },
  reset() { db = freshDb(); save(); notify(); },
  session: {
    get() { try { return JSON.parse(localStorage.getItem(LS_SESSION)); } catch { return null; } },
    set(s) {
      try { s ? localStorage.setItem(LS_SESSION, JSON.stringify(s)) : localStorage.removeItem(LS_SESSION); } catch { /* */ }
      notify();
    },
  },
};

/* ---------- AiAdapter facade (provider switch lives in db.settings) ---------- */
export const AI = {
  provider: () => (db && db.settings.aiProvider) || "mock",
  label: () => aiLabel(AI.provider()),
  translate: (...a) => getAi(AI.provider()).translate(...a),
  classify: (...a) => getAi(AI.provider()).classify(...a),
  scoreUrgency: (...a) => getAi(AI.provider()).scoreUrgency(...a),
  draftPlan: (...a) => getAi(AI.provider()).draftPlan(...a),
  parseUnstructured: (...a) => getAi(AI.provider()).parseUnstructured(...a),
  draftFaq: (...a) => getAi(AI.provider()).draftFaq(...a),
  similarity: (...a) => getAi(AI.provider()).similarity(...a),
};

/* ---------- site config (defaults-on semantics) ---------- */
export const ALL_LANG_CODES = ["en", "nl", "ar", "uk", "ru", "fa", "ti", "tr", "fr", "es", "so", "ps", "prs"];

export function getSiteConfig(d) {
  const c = (d.settings && d.settings.siteConfig) || {};
  return {
    enabledLangs: c.enabledLangs || ALL_LANG_CODES,
    allowSelfAssign: c.allowSelfAssign !== false,
    volunteerAnalytics: c.volunteerAnalytics !== false,
  };
}

export function patchSiteConfig(patch) {
  SBStore.update((d) => {
    d.settings.siteConfig = { ...getSiteConfig(d), ...patch };
  });
}

/* ---------- domain logic ---------- */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function openCount(volId) {
  return db.cases.filter((c) => c.assignedTo === volId && c.status !== "resolved").length;
}

/* Ranking per spec M5: skill×3 + language×2 − load (−5 when unavailable). */
export function rankVolunteers(kase) {
  return db.volunteers
    .filter((v) => v.role === "volunteer")
    .map((v) => {
      const skill = (kase.tags || []).reduce((s, t) => s + (v.skills.includes(t) ? 3 : 0), 0);
      const language = v.languages.includes(kase.language) ? 2 : 0;
      const load = -openCount(v.id);
      const avail = v.available ? 0 : -5;
      return { volunteer: v, score: { skill, language, load, avail, total: skill + language + load + avail }, open: openCount(v.id) };
    })
    .sort((a, b) => b.score.total - a.score.total);
}

/* Same phone/email within 7 days OR text similarity > 0.8 → possible duplicate. */
export function duplicateOf(newCase) {
  const week = Date.now() - 7 * 864e5;
  const hit = db.cases.find((c) => {
    if (c.id === newCase.id || new Date(c.timestamps.created).getTime() < week) return false;
    const norm = (p) => (p || "").replace(/\D/g, "");
    const samePhone = newCase.requester.phone && c.requester.phone && norm(c.requester.phone) === norm(newCase.requester.phone);
    const sameEmail = newCase.requester.email && c.requester.email && c.requester.email.toLowerCase() === newCase.requester.email.toLowerCase();
    const similar = AI.similarity(newCase.originalText, c.originalText) > 0.8;
    return samePhone || sameEmail || similar;
  });
  return hit ? hit.id : null;
}

export function createCase(input, actor) {
  const text = input.originalText || "";
  const urgency = AI.scoreUrgency(text, input.selfReportedUrgent);
  const kase = {
    id: "c" + db.nextCode, code: "RQ-" + db.nextCode,
    channel: input.channel, status: "pending",
    requester: input.requester, language: input.language || "en",
    situation: input.situation || null,
    originalText: text,
    translatedText: AI.translate(text, input.language),
    tags: input.category ? [input.category, ...AI.classify(text).filter((t) => t !== input.category)].slice(0, 3) : AI.classify(text),
    urgency, category: input.category || AI.classify(text)[0],
    appointment: input.appointment || null, callback: input.callback || null,
    assignedTo: null, assignment: null, duplicateOf: null, audioUrl: input.audioUrl || null,
    resolution: { plan: null, statement: null, encrypted: false },
    timeline: [{ event: "Case created via " + input.channel + (actor ? " — logged by " + actor : ""), actor: actor || "Requester", at: new Date().toISOString() }],
    timestamps: { created: new Date().toISOString(), assigned: null, resolved: null },
  };
  kase.duplicateOf = duplicateOf(kase);
  if (kase.duplicateOf) {
    const dup = db.cases.find((c) => c.id === kase.duplicateOf);
    kase.timeline.push({ event: "Possible duplicate of " + (dup ? dup.code : "?") + " detected", actor: "Intake pipeline", at: new Date().toISOString() });
  }
  kase.timeline.push({ event: "AI triage: tagged " + kase.tags.join(", ") + ", urgency " + urgency.level, actor: AI.label(), at: new Date().toISOString() });
  SBStore.update((d) => { d.cases.unshift(kase); d.nextCode++; d.counters.totalCases++; });
  return kase;
}

export function assignCase(caseId, volId, score, byName) {
  SBStore.update((d) => {
    const c = d.cases.find((x) => x.id === caseId);
    const v = d.volunteers.find((x) => x.id === volId);
    if (!c || !v) return;
    c.assignedTo = volId;
    c.assignment = { score, by: byName, at: new Date().toISOString() };
    c.unread = true;
    if (c.status === "pending") c.status = "in_progress";
    c.timestamps.assigned = new Date().toISOString();
    c.timeline.push({ event: "Assigned to " + v.name + " — " + v.skills.map(cap).join(", ") + ", " + v.languages.map((l) => l.toUpperCase()).join("/"), actor: byName, at: new Date().toISOString() });
  });
}

const STATUS_LABEL = { pending: "Pending review", in_progress: "In progress", resolved: "Resolved" };

export function moveCase(caseId, status, actor) {
  SBStore.update((d) => {
    const c = d.cases.find((x) => x.id === caseId);
    if (!c || c.status === status) return;
    c.status = status;
    if (status === "resolved") {
      c.timestamps.resolved = new Date().toISOString();
      d.counters.resolvedCases++;
      d.counters.totalCases = Math.max(d.counters.totalCases, d.counters.resolvedCases);
    }
    c.timeline.push({ event: "Status → " + STATUS_LABEL[status], actor, at: new Date().toISOString() });
  });
}

export function mergeCases(dupId, intoId, actor) {
  SBStore.update((d) => {
    const dup = d.cases.find((x) => x.id === dupId);
    const into = d.cases.find((x) => x.id === intoId);
    if (!dup || !into) return;
    into.timeline.push({ event: "Merged duplicate " + dup.code + " (" + dup.channel + ") into this case", actor, at: new Date().toISOString() });
    if (dup.callback && !into.callback) into.callback = dup.callback;
    d.cases = d.cases.filter((x) => x.id !== dupId);
  });
}

export function logSearch(query, hits, situation) {
  SBStore.update((d) => {
    d.searchLog.unshift({ id: "s" + Math.random().toString(36).slice(2, 8), query, language: "en", situation, hits, ts: new Date().toISOString() });
    if (hits === 0) {
      const key = query.toLowerCase().trim();
      const existing = d.insights.find((i) => i.type === "zero_result" && i.payload.query.toLowerCase() === key && i.status === "open");
      if (existing) existing.payload.count++;
      else d.insights.unshift({ id: "i" + Math.random().toString(36).slice(2, 8), type: "zero_result", payload: { query, count: 1, situations: situation ? [situation] : [] }, status: "open" });
    }
  });
}

/* ---------- crypto (demo-grade, real WebCrypto) ----------
   AES-256-CBC, key = SHA-256 of a 6-char token. Labelled "demo cryptography,
   not audited" everywhere it surfaces in the UI. */
const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export async function encryptCase(text) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => TOKEN_ALPHABET[b % 31]).join("");
  const keyData = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const key = await crypto.subtle.importKey("raw", keyData, { name: "AES-CBC" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(text));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(iv), ...new Uint8Array(ct)));
  return { token, ciphertext: b64 };
}

export async function decryptCase(b64, token) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const keyData = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token.toUpperCase()));
  const key = await crypto.subtle.importKey("raw", keyData, { name: "AES-CBC" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: raw.slice(0, 16) }, key, raw.slice(16));
  return new TextDecoder().decode(pt);
}

/* ---------- Firestore mirror (optional) ----------
   Loaded on demand via dynamic import so the local-first app pays no Firebase
   cost until a config is provided — either VITE_FIREBASE_* env vars at build
   time or a pasted JSON config in the staff settings drawer at runtime. */
export const fb = {
  status: "off", error: null, fs: null, auth: null, user: null,
  _api: null, // { doc, setDoc, getDoc, onSnapshot, getAuth, signInAnonymously }
  _unsubscribe: null,
  _applyingRemote: false,

  async connect(configJson) {
    try {
      const config = typeof configJson === "string" ? JSON.parse(configJson) : configJson;
      if (!config.projectId || !config.apiKey) throw new Error("Config needs at least apiKey and projectId");
      fb.status = "loading"; notify();
      const { initializeApp, getApps, getApp } = await import("firebase/app");
      const { getFirestore, doc, setDoc, getDoc, onSnapshot } = await import("firebase/firestore");
      const { getAuth, signInAnonymously } = await import("firebase/auth");
      const app = getApps().length ? getApp() : initializeApp(config);
      fb.fs = getFirestore(app);
      fb.auth = getAuth(app);
      const cred = fb.auth.currentUser ? { user: fb.auth.currentUser } : await signInAnonymously(fb.auth);
      fb.user = cred.user;
      fb._api = { doc, setDoc, getDoc, onSnapshot, getAuth, signInAnonymously };
      fb.status = "connected"; fb.error = null;
      fb._applyingRemote = true;
      SBStore.update((d) => { d.settings.dataSource = "firebase"; d.settings.firebaseConfig = typeof configJson === "string" ? configJson : JSON.stringify(configJson); });
      fb._applyingRemote = false;
      fb.subscribe();
      const hasRemoteSnapshot = await fb.pull();
      if (!hasRemoteSnapshot) fb.mirror();
      return true;
    } catch (e) {
      fb._applyingRemote = false;
      fb.status = "error"; fb.error = e.message; notify();
      return false;
    }
  },

  disconnect() {
    if (fb._unsubscribe) fb._unsubscribe();
    fb._unsubscribe = null;
    fb.status = "off"; fb.fs = null; fb._api = null;
    SBStore.update((d) => { d.settings.dataSource = "local"; });
  },

  subscribe() {
    if (fb._unsubscribe || !fb.fs || !fb._api) return;
    const { doc, onSnapshot } = fb._api;
    fb._unsubscribe = onSnapshot(doc(fb.fs, "signaalbrug", "snapshot"), (snap) => {
      if (!snap.exists()) return;
      try {
        const next = JSON.parse(snap.data().json);
        fb._applyingRemote = true;
        replaceFromRemote(next);
      } catch (e) {
        fb.error = e.message; notify();
      } finally {
        fb._applyingRemote = false;
      }
    }, (e) => { fb.error = e.message; notify(); });
  },

  mirror() {
    if (fb.status !== "connected" || !fb.fs) return;
    try {
      const { doc, setDoc } = fb._api;
      const snapshot = { json: JSON.stringify({ cases: db.cases, counters: db.counters, faq: db.faq, insights: db.insights }), at: new Date().toISOString() };
      setDoc(doc(fb.fs, "signaalbrug", "snapshot"), snapshot).catch((e) => { fb.error = e.message; });
    } catch { /* never break the demo */ }
  },

  async pull() {
    if (fb.status !== "connected") return false;
    try {
      const { doc, getDoc } = fb._api;
      const snap = await getDoc(doc(fb.fs, "signaalbrug", "snapshot"));
      if (snap.exists()) {
        const data = JSON.parse(snap.data().json);
        fb._applyingRemote = true;
        replaceFromRemote(data);
        fb._applyingRemote = false;
        return true;
      }
    } catch (e) { fb._applyingRemote = false; fb.error = e.message; notify(); }
    return false;
  },
};

/* ---------- format utils ---------- */
export const fmt = {
  timeAgo(iso) {
    if (!iso) return "—";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  },
  d(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  },
  /* Which date matters for this case right now:
     unassigned → created · assigned & pending → assigned · in progress → due date
     (user-set, else derived from avg resolution velocity of same-category cases) · resolved → resolved */
  caseDate(kase) {
    const t = kase.timestamps || {};
    if (kase.status === "resolved") return { label: "Resolved", iso: t.resolved, est: false };
    if (kase.status === "in_progress") {
      if (kase.due) return { label: "Target", iso: kase.due, est: false };
      const done = (db.cases || []).filter((c) => c.timestamps && c.timestamps.resolved);
      const sameCat = done.filter((c) => c.category === kase.category);
      const pool = sameCat.length ? sameCat : done;
      let avg = 3 * 864e5; // fallback: 3 days
      if (pool.length) {
        avg = pool.reduce((s, c) => s + Math.max(0, new Date(c.timestamps.resolved) - new Date(c.timestamps.assigned || c.timestamps.created)), 0) / pool.length;
        avg = Math.max(avg, 12 * 36e5); // never estimate under 12h
      }
      const start = new Date(t.assigned || t.created).getTime();
      return {
        label: "Est. completion", iso: new Date(start + avg).toISOString(), est: true,
        basis: sameCat.length ? cap(kase.category || "similar") + " cases (" + sameCat.length + " resolved)" : "all resolved cases",
      };
    }
    if (kase.assignedTo) return { label: "Assigned", iso: t.assigned || t.created, est: false };
    return { label: "Created", iso: t.created, est: false };
  },
  dt(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  },
  cap,
};

/* ---------- init ---------- */
load();

// Auto-connect the mirror when a Firebase web config ships in the build env.
const envConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
if (envConfig.apiKey && envConfig.projectId) fb.connect(envConfig);
