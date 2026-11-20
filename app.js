/* Haushaltsbuch – Web-App
 * Daten liegen als eine JSON-Datei in Google Drive (oder lokal im Browser).
 * Zwei getrennte Bücher: Privat und Gewerbe.
 */
"use strict";

const CFG = Object.assign({ googleClientId: "", driveFolder: "Haushaltsbuch", driveFile: "haushaltsbuch.json" }, window.APP_CONFIG || {});
const SCHEMA = 1;
// eigene Namen, damit sich Haushaltsbuch und Deko-App (gleiche Adresse) nicht in die Quere kommen
const LS = { data: "hb_data", meta: "hb_meta", mode: "hb_mode", token: "hb_token", tab: "hb_tab", book: "hb_book" };

/* =================================================================== Hilfen */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clone = (o) => JSON.parse(JSON.stringify(o));
const fEUR = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const eur = (cent) => fEUR.format((cent || 0) / 100);
const eurS = (cent) => (cent > 0 ? "+" : cent < 0 ? "−" : "") + fEUR.format(Math.abs(cent || 0) / 100);
/* "12,5" / "1.234,56" / "12.50" → Cent */
const toCent = (v) => {
  if (v === "" || v == null) return null;
  if (typeof v === "number") return Math.round(v * 100);
  let s = String(v).replace(/[€\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s); return isFinite(n) ? Math.round(n * 100) : null;
};
const centIn = (c) => c == null ? "" : (c / 100).toFixed(2).replace(".", ",");
const todayISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const fDate = (iso) => iso ? iso.split("-").reverse().join(".") : "–";
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const isoOf = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10); // m 0-basiert, rollt über
const dayLabel = (iso) => {
  const t = todayISO(); if (iso === t) return "Heute";
  const y = new Date(Date.parse(t) - 864e5).toISOString().slice(0, 10); if (iso === y) return "Gestern";
  const d = new Date(iso + "T12:00:00Z"); return `${WD[d.getUTCDay()]}, ${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}`;
};

let toastTimer;
function toast(msg, action, ms = 3200) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ""}`;
  if (action) $("button", t).onclick = () => { t.classList.remove("on"); action.fn(); };
  t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), action ? 5000 : ms);
}

/* =================================================================== Speicher: lokal + Google Drive */
const Sync = {
  mode: lsGet(LS.mode), // "drive" | "local" | null
  status: "idle", // idle | saving | saved | offline | error | auth
  fileId: null, folderId: null, photoFolderId: null, version: null, lastSave: null,
  dirty: false, timer: null, token: null, tokenExp: 0, tokenClient: null, email: null,

  setStatus(st) { this.status = st; renderSync(); },

  loadCache() {
    const d = lsGet(LS.data); const m = lsGet(LS.meta) || {};
    Object.assign(this, { fileId: m.fileId || null, folderId: m.folderId || null, photoFolderId: m.photoFolderId || null,
      version: m.version || null, lastSave: m.lastSave || null, dirty: !!m.dirty, email: m.email || null });
    return d;
  },
  saveCache() {
    lsSet(LS.data, db);
    lsSet(LS.meta, { fileId: this.fileId, folderId: this.folderId, photoFolderId: this.photoFolderId, version: this.version, lastSave: this.lastSave,
      dirty: this.dirty, email: this.email });
  },

  changed() {
    db.updated = new Date().toISOString();
    this.dirty = true; this.saveCache();
    if (this.mode === "drive") { clearTimeout(this.timer); this.timer = setTimeout(() => this.push(), 1200); this.setStatus("saving"); }
  },

  /* ---------- Google-Anmeldung ---------- */
  gisReady() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (this._gis) return this._gis;
    this._gis = new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = () => res(); s.onerror = () => { this._gis = null; rej(new Error("Google-Anmeldung nicht erreichbar (offline?)")); };
      document.head.appendChild(s);
    });
    return this._gis;
  },
  async getToken(interactive) {
    if (this.token && Date.now() < this.tokenExp - 60e3) return this.token;
    const cached = lsGet(LS.token);
    if (cached && Date.now() < cached.exp - 60e3) { this.token = cached.t; this.tokenExp = cached.exp; return this.token; }
    if (!interactive) throw Object.assign(new Error("Anmeldung nötig"), { auth: true });
    await this.gisReady();
    return new Promise((res, rej) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: CFG.googleClientId,
        scope: "https://www.googleapis.com/auth/drive.file",
        callback: (r) => {
          if (r.error) return rej(new Error("Anmeldung abgebrochen"));
          this.token = r.access_token; this.tokenExp = Date.now() + (r.expires_in || 3600) * 1000;
          lsSet(LS.token, { t: this.token, exp: this.tokenExp });
          res(this.token);
        },
        error_callback: (e) => rej(new Error(e?.type === "popup_closed" ? "Anmeldefenster geschlossen" : "Anmeldung fehlgeschlagen"))
      });
      tc.requestAccessToken({ prompt: this.email ? "" : "consent", hint: this.email || undefined });
    });
  },
  async api(url, opts = {}, interactive = false) {
    const tok = await this.getToken(interactive);
    const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: "Bearer " + tok }, opts.headers || {}) }));
    if (r.status === 401) { this.token = null; lsDel(LS.token); throw Object.assign(new Error("Anmeldung abgelaufen"), { auth: true }); }
    if (!r.ok) throw new Error("Google Drive: Fehler " + r.status);
    return r;
  },
  q(s) { return encodeURIComponent(s); },
  async findOrCreateFolder(name, parent, interactive) {
    const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : "");
    const r = await (await this.api(`https://www.googleapis.com/drive/v3/files?q=${this.q(q)}&fields=files(id)&spaces=drive`, {}, interactive)).json();
    if (r.files?.length) return r.files[0].id;
    const c = await (await this.api("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parent ? [parent] : undefined })
    }, interactive)).json();
    return c.id;
  },
  async multipart(meta, blob, method = "POST", id = "") {
    const fd = new FormData();
    fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
    fd.append("file", blob);
    const url = `https://www.googleapis.com/upload/drive/v3/files${id ? "/" + id : ""}?uploadType=multipart&fields=id,md5Checksum`;
    return (await this.api(url, { method, body: fd })).json();
  },
  async whoAmI() {
    try {
      const r = await (await this.api("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)")).json();
      this.email = r.user?.emailAddress || this.email;
    } catch {}
  },

  /* Verbinden: Ordner + Datei suchen/anlegen, Daten laden */
  async connect(interactive) {
    await this.getToken(interactive);
    await this.whoAmI();
    this.folderId = await this.findOrCreateFolder(CFG.driveFolder, null, interactive);
    const q = `name='${CFG.driveFile}' and '${this.folderId}' in parents and trashed=false`;
    const r = await (await this.api(`https://www.googleapis.com/drive/v3/files?q=${this.q(q)}&fields=files(id,version)&spaces=drive`)).json();
    if (r.files?.length) {
      this.fileId = r.files[0].id;
      return "exists";
    }
    return "missing";
  },
  /* Prüfsumme des Dateiinhalts – ändert sich nur, wenn sich der Inhalt ändert */
  async checksum() {
    const m = await (await this.api(`https://www.googleapis.com/drive/v3/files/${this.fileId}?fields=md5Checksum`)).json();
    return m.md5Checksum || null;
  },
  /* Wurde die Datei seit unserem letzten Speichern von einem anderen Gerät überschrieben? */
  async changedElsewhere() {
    const sum = await this.checksum();
    if (!this.version || sum === this.version) { this.version = sum; return false; }
    // Inhalt hat sich geändert: stammt der Stand trotzdem von unserem letzten Speichern?
    const remote = await (await this.api(`https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`)).json();
    const legacy = !/^[0-9a-f]{32}$/.test(this.version);   // Stand aus der Vorversion der App
    if (legacy || !remote.saveId || remote.saveId === this.lastSave) { this.version = sum; return false; }
    return true;
  },
  async pull() {
    const data = await (await this.api(`https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`)).json();
    this.version = await this.checksum();
    this.lastSave = data.saveId || null;
    return data;
  },
  async createFile(data) {
    const r = await this.multipart({ name: CFG.driveFile, parents: [this.folderId], mimeType: "application/json" },
      new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
    this.fileId = r.id; this.version = r.md5Checksum; this.lastSave = data.saveId || null;
  },
  async push(force = false) {
    if (this.mode !== "drive" || !this.dirty) { if (this.mode === "drive") this.setStatus("saved"); return; }
    if (!navigator.onLine) return this.setStatus("offline");
    if (this._pushing) { clearTimeout(this.timer); this.timer = setTimeout(() => this.push(), 1500); return; }
    this._pushing = true; this.setStatus("saving");
    try {
      if (!this.fileId) { await this.connect(false); if (!this.fileId) await this.createFile(db); }
      if (!force && await this.changedElsewhere()) { this._pushing = false; return conflictDialog(); }
      db.saveId = uid();
      const r = await (await this.api(`https://www.googleapis.com/upload/drive/v3/files/${this.fileId}?uploadType=media&fields=md5Checksum`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(db, null, 1)
      })).json();
      this.version = r.md5Checksum; this.lastSave = db.saveId; this.dirty = false; this.saveCache(); this.setStatus("saved");
    } catch (e) {
      console.warn(e);
      this.setStatus(e.auth ? "auth" : navigator.onLine ? "error" : "offline");
    } finally { this._pushing = false; }
  },
  /* Beim Zurückkehren zur App prüfen, ob auf einem anderen Gerät gespeichert wurde */
  async refresh() {
    if (this.mode !== "drive" || !this.fileId || this.dirty || !navigator.onLine) return;
    try {
      if (await this.checksum() !== this.version) {
        const before = this.lastSave;
        const data = await this.pull();
        if (!before || data.saveId !== before) { db = migrate(data); render(); toast("Neue Daten vom anderen Gerät geladen"); }
        this.saveCache();
      }
      this.setStatus("saved");
    } catch (e) { if (e.auth) this.setStatus("auth"); }
  },

  /* ---------- Fotos ---------- */
  async photoFolder() {
    if (this.photoFolderId) return this.photoFolderId;
    if (!this.folderId) this.folderId = await this.findOrCreateFolder(CFG.driveFolder, null, false);
    this.photoFolderId = await this.findOrCreateFolder("Belege", this.folderId, false);
    this.saveCache();
    return this.photoFolderId;
  },
  async putPhoto(blob, name) {
    if (this.mode === "drive") {
      const folder = await this.photoFolder();
      const r = await this.multipart({ name, parents: [folder], mimeType: "image/jpeg" }, blob);
      await PhotoCache.put(r.id, blob);
      return r.id;
    }
    const id = "local:" + uid();
    await IDB.put(id, blob);
    return id;
  },
  async getPhoto(id) {
    if (id.startsWith("local:")) return IDB.get(id);
    const cached = await PhotoCache.get(id);
    if (cached) return cached;
    if (this.mode !== "drive") return null;
    const r = await this.api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    const b = await r.blob(); await PhotoCache.put(id, b); return b;
  },
  async dropPhoto(id) {
    if (!id) return;
    try {
      if (id.startsWith("local:")) return IDB.del(id);
      await this.api(`https://www.googleapis.com/drive/v3/files/${id}?fields=id`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
    } catch (e) { console.warn(e); }
  }
};

/* Foto-Zwischenspeicher (Cache Storage) und lokale Fotos (IndexedDB) */
const PhotoCache = {
  async c() { try { return await caches.open("hb-photos"); } catch { return null; } },
  async get(id) { const c = await this.c(); const r = c && await c.match("/photo/" + id); return r ? r.blob() : null; },
  async put(id, b) { const c = await this.c(); if (c) await c.put("/photo/" + id, new Response(b)); }
};
const IDB = {
  db() {
    return this._db ||= new Promise((res, rej) => {
      const r = indexedDB.open("hb", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("photos");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) { const d = await this.db(); return new Promise((res, rej) => { const t = d.transaction("photos", mode); const q = fn(t.objectStore("photos")); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); },
  get(id) { return this.tx("readonly", (s) => s.get(id)); },
  put(id, b) { return this.tx("readwrite", (s) => s.put(b, id)); },
  del(id) { return this.tx("readwrite", (s) => s.delete(id)); }
};
const photoURLs = new Map();
async function photoURL(id) {
  if (!id) return null;
  if (photoURLs.has(id)) return photoURLs.get(id);
  try { const b = await Sync.getPhoto(id); if (!b) return null; const u = URL.createObjectURL(b); photoURLs.set(id, u); return u; }
  catch { return null; }
}
/* Fotos nachladen: <span data-photo="id"> wird durch <img> ersetzt */
function hydratePhotos(root = document) {
  $$("[data-photo]", root).forEach(async (el) => {
    const id = el.dataset.photo; if (!id) return;
    const u = await photoURL(id);
    if (u && el.isConnected) { el.innerHTML = `<img src="${u}" alt="">`; }
  });
}
function resizeImage(file, max = 1200) {
  return new Promise((res, rej) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement("canvas"); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(u); cv.toBlob((b) => b ? res(b) : rej(new Error("Bild konnte nicht verarbeitet werden")), "image/jpeg", 0.82);
    };
    img.onerror = () => rej(new Error("Bild konnte nicht gelesen werden"));
    img.src = u;
  });
}


/* =================================================================== Datenmodell */
const BOOKS = { privat: "Privat", gewerbe: "Gewerbe" };
const ART_KONTO = { giro: "Girokonto", bar: "Bargeld", paypal: "PayPal", sonst: "Sonstiges" };
const ART_ICON = { giro: "🏦", bar: "💶", paypal: "🅿️", sonst: "💳" };

function defaultCategories() {
  const out = []; let n = 0;
  const add = (buch, typ, name, icon, fix, subs) => {
    const id = "k" + (++n); out.push({ id, buch, typ, name, icon, fix: !!fix, parent: null, hidden: false });
    (subs || []).forEach((s) => { const [sn, sfix] = Array.isArray(s) ? s : [s, fix]; out.push({ id: "k" + (++n), buch, typ, name: sn, icon, fix: !!sfix, parent: id, hidden: false }); });
  };
  add("privat", "aus", "Wohnen", "🏠", true, ["Miete", "Strom", "Wasser", "Heizung", "Internet & Telefon", "Rundfunkbeitrag"]);
  add("privat", "aus", "Versicherungen", "🛡️", true, ["Haftpflicht", "Hausrat", "Kfz", "Sonstige"]);
  add("privat", "aus", "Abos & Mitgliedschaften", "🔁", true, ["Handy", "Streaming", "Verein"]);
  add("privat", "aus", "Lebensmittel", "🛒", false, ["Supermarkt", "Bäcker", "Markt"]);
  add("privat", "aus", "Haushalt & Drogerie", "🧴", false, ["Drogerie", "Haushaltswaren"]);
  add("privat", "aus", "Mobilität", "🚗", false, ["Tanken", "Werkstatt", "Bus & Bahn"]);
  add("privat", "aus", "Gesundheit", "💊", false, ["Apotheke", "Arzt"]);
  add("privat", "aus", "Freizeit", "🎉", false, ["Essen gehen", "Hobby", "Urlaub"]);
  add("privat", "aus", "Kleidung", "👕", false);
  add("privat", "aus", "Geschenke", "🎁", false);
  add("privat", "aus", "Sonstiges", "📦", false);
  add("privat", "ein", "Einnahmen", "💶", false, [["Gehalt", true], "Erstattungen", "Sonstiges"]);
  add("gewerbe", "aus", "Wareneinsatz", "🧵", false, ["Material", "Verpackung"]);
  add("gewerbe", "aus", "Verkauf", "🏷️", false, ["Marktgebühren", "Plattform- & Bankgebühren", "Werbung"]);
  add("gewerbe", "aus", "Betrieb", "🔧", false, ["Werkzeug", "Fahrtkosten", "Sonstiges"]);
  add("gewerbe", "ein", "Erlöse", "💰", false, ["Verkauf Markt", "Verkauf Auftrag/online", "Sonstiges"]);
  return out;
}
// Reihenfolge der Kacheln, solange es noch keine Buchungen gibt
const FAV = {
  "privat-aus": ["Supermarkt", "Bäcker", "Drogerie", "Tanken", "Essen gehen", "Apotheke", "Kleidung"],
  "privat-ein": ["Gehalt", "Erstattungen", "Sonstiges"],
  "gewerbe-aus": ["Material", "Verpackung", "Marktgebühren", "Fahrtkosten", "Werkzeug"],
  "gewerbe-ein": ["Verkauf Markt", "Verkauf Auftrag/online"]
};

function emptyDB() {
  const t = todayISO();
  return {
    schema: SCHEMA, updated: new Date().toISOString(),
    settings: { privat: { monatsStart: 27 }, gewerbe: { monatsStart: 1 }, last: {}, onboarded: false },
    konten: [
      { id: "a1", name: "Girokonto", buch: "privat", art: "giro", start: 0, startDatum: t, archiv: false },
      { id: "a2", name: "Bargeld", buch: "privat", art: "bar", start: 0, startDatum: t, archiv: false },
      { id: "a3", name: "PayPal", buch: "privat", art: "paypal", start: 0, startDatum: t, archiv: false }
    ],
    kategorien: defaultCategories(),
    buchungen: []
  };
}
function migrate(d) {
  const base = emptyDB();
  if (!d || typeof d !== "object" || !Array.isArray(d.konten)) return base;
  d.settings = Object.assign(base.settings, d.settings || {});
  d.settings.privat = Object.assign({ monatsStart: 27 }, d.settings.privat || {});
  d.settings.gewerbe = Object.assign({ monatsStart: 1 }, d.settings.gewerbe || {});
  d.settings.last ||= {};
  if (!Array.isArray(d.kategorien)) d.kategorien = base.kategorien;
  if (!Array.isArray(d.buchungen)) d.buchungen = [];
  d.schema = SCHEMA;
  return d;
}
let db = null;
let book = lsGet(LS.book, "privat");

const kontoById = (id) => db.konten.find((k) => k.id === id);
const katById = (id) => db.kategorien.find((k) => k.id === id);
const kontoBook = (id) => kontoById(id)?.buch;
const nextKontoId = () => "a" + (Math.max(0, ...db.konten.map((k) => +k.id.slice(1) || 0)) + 1);
const nextKatId = () => "k" + (Math.max(0, ...db.kategorien.map((k) => +k.id.slice(1) || 0)) + 1);
const katLabel = (k) => k ? (k.parent ? k.name : k.name) : "Ohne Kategorie";
const katMain = (k) => k ? (k.parent ? katById(k.parent) : k) : null;
const katIcon = (k) => katMain(k)?.icon || "•";
const hasChildren = (id) => db.kategorien.some((k) => k.parent === id && !k.hidden);
const leafCats = (b, typ) => db.kategorien.filter((k) => k.buch === b && k.typ === typ && !k.hidden && !hasChildren(k.id) && (!k.parent || !katById(k.parent)?.hidden));
const kontenOf = (b, withArchiv = false) => db.konten.filter((k) => k.buch === b && (withArchiv || !k.archiv));

/* ---------- Abrechnungsmonat ----------
 * Beginnt am Tag `monatsStart`; benannt nach dem Monat, in dem er endet. */
function period(b, offset = 0, refISO = todayISO()) {
  const S = Math.min(28, Math.max(1, db.settings[b]?.monatsStart || 1));
  const [y, m, d] = refISO.split("-").map(Number);
  let sy = y, sm = m - 1;            // Startmonat (0-basiert)
  if (S > 1 && d < S) sm -= 1;
  sm += offset;
  const from = isoOf(sy, sm, S);
  const to = isoOf(sy, sm + (S > 1 ? 1 : 1), S > 1 ? S - 1 : 0);
  const end = new Date(to + "T12:00:00Z");
  return { from, to, label: `${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`, offset,
    range: `${fDate(from).slice(0, 6)} – ${fDate(to).slice(0, 6)}` };
}
const inPeriod = (iso, p) => iso >= p.from && iso <= p.to;

/* ---------- Wie wirkt eine Buchung auf ein Buch? ----------
 * aus / ein: normale Ausgabe/Einnahme in diesem Buch
 * um: Umbuchung innerhalb des Buchs
 * entnahme / einlage: Geld zwischen den Büchern (dir = +1 rein, -1 raus aus Sicht des Buchs) */
function relation(x, b) {
  if (x.art === "aus" || x.art === "ein") {
    if (x.buch === b) return { kind: x.art, cent: x.cent, cross: kontoBook(x.konto) !== b };
    if (kontoBook(x.konto) === b) {            // Gewerbe-Buchung über ein privates Konto
      return x.art === "aus" ? { kind: "einlage", dir: -1, cent: x.cent } : { kind: "entnahme", dir: +1, cent: x.cent };
    }
    return null;
  }
  if (x.art === "um") {
    const fb = kontoBook(x.konto), tb = kontoBook(x.ziel);
    if (fb === b && tb === b) return { kind: "um", cent: x.cent };
    if (fb === b) return { kind: b === "gewerbe" ? "entnahme" : "einlage", dir: -1, cent: x.cent };
    if (tb === b) return { kind: b === "gewerbe" ? "einlage" : "entnahme", dir: +1, cent: x.cent };
  }
  return null;
}
function balance(kontoId, upto = null) {
  const k = kontoById(kontoId); let s = k?.start || 0;
  for (const x of db.buchungen) {
    if (upto && x.datum > upto) continue;
    if (x.konto === kontoId) s += x.art === "ein" ? x.cent : -x.cent;
    if (x.art === "um" && x.ziel === kontoId) s += x.cent;
  }
  return s;
}
function summary(b, p) {
  const r = { ein: 0, aus: 0, entnahme: 0, einlage: 0, n: 0, byKat: {} };
  for (const x of db.buchungen) {
    if (!inPeriod(x.datum, p)) continue;
    const rel = relation(x, b); if (!rel) continue;
    r.n++;
    if (rel.kind === "ein" || rel.kind === "aus") {
      r[rel.kind] += rel.cent;
      const k = katById(x.kat), main = katMain(k);
      const key = rel.kind + ":" + (main?.id || "-");
      (r.byKat[key] ||= { typ: rel.kind, main, cent: 0, subs: {} }).cent += rel.cent;
      const sk = k?.id || "-"; r.byKat[key].subs[sk] = (r.byKat[key].subs[sk] || 0) + rel.cent;
    }
    if (rel.kind === "entnahme") r.entnahme += rel.cent;
    if (rel.kind === "einlage") r.einlage += rel.cent;
    // Privat: Geld aus dem Gewerbe ist Einnahme, Geld ins Gewerbe ist Ausgabe
    if (b === "privat" && (rel.kind === "entnahme" || rel.kind === "einlage")) {
      const typ = rel.kind === "entnahme" ? "ein" : "aus";
      r[typ] += rel.cent;
      const key = typ + ":__gew";
      (r.byKat[key] ||= { typ, main: { id: "__gew", icon: "⇄", name: typ === "ein" ? "Aus dem Gewerbe" : "Ins Gewerbe" }, cent: 0, subs: {} }).cent += rel.cent;
    }
  }
  // Saldo: privat inkl. Geld aus/ins Gewerbe, Gewerbe = Gewinn ohne Entnahmen/Einlagen
  r.saldo = r.ein - r.aus;
  return r;
}
/* Kacheln: meistgenutzte Kategorien der letzten 120 Tage, sonst Startreihenfolge */
function tileCats(b, typ, count = 7) {
  const leaves = leafCats(b, typ);
  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const freq = {};
  db.buchungen.forEach((x) => { if (x.buch === b && x.art === typ && x.datum >= since) freq[x.kat] = (freq[x.kat] || 0) + 1; });
  const fav = FAV[b + "-" + typ] || [];
  const rank = (k) => (freq[k.id] || 0) * 1000 - (fav.includes(k.name) ? fav.indexOf(k.name) : 99);
  return leaves.slice().sort((a, c) => rank(c) - rank(a)).slice(0, count);
}

/* =================================================================== Rendering */
const TABS = [
  ["start", "Start", '<path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
  ["liste", "Buchungen", '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1.2"/><circle cx="4" cy="12" r="1.2"/><circle cx="4" cy="18" r="1.2"/>'],
  ["auswertung", "Auswertung", '<path d="M21 12a9 9 0 1 1-9-9v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'],
  ["mehr", "Mehr", '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>']
];
let tab = lsGet(LS.tab, "start");
const ui = { off: { liste: 0, auswertung: 0 }, q: "", filter: "alle" };
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

function renderShell() {
  $("#app").innerHTML = `<div class="shell">
    <header class="topbar"><div class="r1">
      <div class="switch">${Object.entries(BOOKS).map(([k, l]) => `<button data-book="${k}">${l}</button>`).join("")}</div>
      <button class="sync" id="sync" data-act="sync" aria-label="Speicherstatus"><span class="dot"></span></button></div></header>
    <div id="banner"></div><main id="view"></main>
    <nav class="tabs">${TABS.map(([k, l, p]) => `<button data-tab="${k}">${svg(p)}<span>${l}</span></button>`).join("")}</nav>
    <button class="fab" data-act="neu" aria-label="Buchung erfassen">+</button></div>`;
}
function renderSync() {
  const el = $("#sync"); if (!el) return;
  const map = { saving: "saving", offline: "offline", error: "error", auth: "error" };
  el.className = "sync " + (Sync.mode === "local" ? "local" : map[Sync.status] || "");
  el.title = Sync.mode === "local" ? "Nur auf diesem Gerät" : ({ saving: "Speichert …", offline: "Offline – wird später gespeichert", error: "Speichern fehlgeschlagen", auth: "Neu anmelden" }[Sync.status] || "Gespeichert");
  const b = $("#banner");
  if (b) b.innerHTML = Sync.mode === "drive" && Sync.status === "auth"
    ? `<div class="authbar"><span>Zum Speichern bitte kurz neu anmelden.</span><button class="btn small primary" data-act="sync">Anmelden</button></div>` : "";
}
function render() {
  if (!db || !$("#view")) return;
  document.body.dataset.book = book;
  $('meta[name="theme-color"]').content = book === "gewerbe" ? "#2F6B6F" : "#4A4E69";
  $$(".switch button").forEach((x) => x.classList.toggle("on", x.dataset.book === book));
  $$("nav.tabs button").forEach((x) => x.classList.toggle("on", x.dataset.tab === tab));
  $("#view").innerHTML = ({ start: viewStart, liste: viewListe, auswertung: viewAuswertung, mehr: viewMehr }[tab] || viewStart)();
  renderSync();
}
function go(t) { tab = t; lsSet(LS.tab, t); render(); window.scrollTo(0, 0); }

/* Eine Buchung als Listenzeile, aus Sicht des Buchs b */
function rowHTML(x, b) {
  const rel = relation(x, b); if (!rel) return "";
  const k = katById(x.kat), konto = kontoById(x.konto), ziel = kontoById(x.ziel);
  let icon = katIcon(k), title = katLabel(k), sub = [], val = 0, cls = "";
  if (rel.kind === "aus") { val = -rel.cent; cls = "out"; }
  else if (rel.kind === "ein") { val = rel.cent; cls = "in"; }
  if (rel.kind === "um") { icon = "⇄"; title = "Umbuchung"; sub.push(`${konto?.name} → ${ziel?.name}`); }
  else if (rel.kind === "entnahme" || rel.kind === "einlage") {
    icon = "⇄"; title = rel.kind === "entnahme" ? "Entnahme aus Gewerbe" : "Einlage ins Gewerbe";
    if (b === "gewerbe") title = rel.kind === "entnahme" ? "Entnahme (an Privat)" : "Einlage (von Privat)";
    val = rel.dir * rel.cent; cls = val < 0 ? "out" : "in";
    if (x.art !== "um") sub.push((x.art === "aus" ? "Gewerbe-Ausgabe: " : "Gewerbe-Einnahme: ") + katLabel(k));
    else sub.push(`${konto?.name} → ${ziel?.name}`);
  }
  if (rel.kind === "aus" || rel.kind === "ein") {
    if (k?.parent) sub.push(katById(k.parent)?.name);
    if (konto) sub.push(rel.cross ? `privat ${rel.kind === "aus" ? "bezahlt" : "erhalten"} (${konto.name})` : konto.name);
  }
  if (x.notiz) sub.unshift(x.notiz);
  return `<button class="item" data-act="edit" data-id="${x.id}"><span class="ic">${icon}</span>
    <span class="m"><span class="t">${esc(title)}</span><span class="s">${esc(sub.filter(Boolean).join(" · "))}</span></span>
    <span class="v ${cls}">${rel.kind === "um" ? eur(rel.cent) : eurS(val)}</span></button>`;
}
function bookingsFor(b, filterFn = () => true) {
  return db.buchungen.filter((x) => relation(x, b) && filterFn(x))
    .sort((a, c) => c.datum.localeCompare(a.datum) || (c.created || "").localeCompare(a.created || ""));
}
function grouped(list, b) {
  let html = "", day = null, chunk = [];
  const flush = () => {
    if (!chunk.length) return;
    const sum = chunk.reduce((s, x) => { const r = relation(x, b); return s + (r.kind === "aus" ? -r.cent : r.kind === "ein" ? r.cent : r.kind === "um" ? 0 : r.dir * r.cent); }, 0);
    html += `<div class="day"><span>${dayLabel(day)}</span><span>${eurS(sum)}</span></div><div class="list">${chunk.map((x) => rowHTML(x, b)).join("")}</div>`;
    chunk = [];
  };
  for (const x of list) { if (x.datum !== day) { flush(); day = x.datum; } chunk.push(x); }
  flush();
  return html;
}
function kontenHTML(b) {
  const ks = kontenOf(b);
  if (!ks.length) return `<div class="hint">Noch kein ${BOOKS[b]}-Konto angelegt. ${b === "gewerbe" ? "Bis das Geschäftskonto da ist, wähle beim Erfassen „privat bezahlt“ bzw. „privat erhalten“. Konto anlegen unter Mehr → Konten." : ""}</div>`;
  return `<div class="list">${ks.map((k) => { const s = balance(k.id); return `<button class="item" data-act="konto" data-id="${k.id}"><span class="ic">${ART_ICON[k.art] || "💳"}</span>
    <span class="m"><span class="t">${esc(k.name)}</span><span class="s">${ART_KONTO[k.art] || ""}</span></span><span class="v ${s < 0 ? "out" : ""}">${eur(s)}</span></button>`; }).join("")}</div>`;
}

/* ---------- Start ---------- */
function viewStart() {
  const p = period(book), s = summary(book, p);
  const total = kontenOf(book).reduce((a, k) => a + balance(k.id), 0);
  const recent = bookingsFor(book).slice(0, 6);
  let hero;
  if (book === "privat") {
    hero = `<div class="card hero"><div class="l">Auf allen Konten</div><div class="big">${eur(total)}</div>
      <div class="l" style="margin-bottom:6px">${esc(p.label)} · ${p.range}</div>
      <div class="row"><div><small>Einnahmen</small><b>${eur(s.ein)}</b></div><div><small>Ausgaben</small><b>${eur(s.aus)}</b></div><div><small>Saldo</small><b>${eurS(s.saldo)}</b></div></div></div>`;
  } else {
    const t = todayISO(), sales = db.buchungen.filter((x) => x.buch === "gewerbe" && x.art === "ein" && x.datum === t);
    hero = `<div class="card hero"><div class="l">Gewinn ${esc(p.label)}</div><div class="big">${eurS(s.saldo)}</div>
      <div class="row"><div><small>Einnahmen</small><b>${eur(s.ein)}</b></div><div><small>Ausgaben</small><b>${eur(s.aus)}</b></div>
      <div><small>Heute verkauft</small><b>${sales.length ? eur(sales.reduce((a, x) => a + x.cent, 0)) : "–"}</b></div></div></div>`;
  }
  return `${hero}
    <div class="h3"><span>Konten</span></div>${kontenHTML(book)}
    <div class="h3"><span>Zuletzt</span>${recent.length ? `<button data-tab="liste">Alle</button>` : ""}</div>
    ${recent.length ? grouped(recent, book) : `<div class="empty"><b>Noch keine Buchungen</b>Tippe auf <b style="display:inline">+</b>, um die erste Ausgabe einzutragen.</div>`}`;
}

/* ---------- Buchungen ---------- */
function periodNav(key) {
  const p = period(book, ui.off[key]);
  return `<div class="period"><button data-act="prev" data-k="${key}" aria-label="Vorheriger Monat">‹</button>
    <div class="pl"><b>${esc(p.label)}</b><span>${p.range}</span></div>
    <button data-act="next" data-k="${key}" ${ui.off[key] >= 0 ? "disabled" : ""} aria-label="Nächster Monat">›</button></div>`;
}
function viewListe() {
  const p = period(book, ui.off.liste), q = ui.q.trim().toLowerCase();
  const f = ui.filter;
  const list = bookingsFor(book, (x) => {
    if (!q && !inPeriod(x.datum, p)) return false;
    const r = relation(x, book);
    if (f === "aus" && r.kind !== "aus") return false;
    if (f === "ein" && r.kind !== "ein") return false;
    if (f === "um" && !["um", "entnahme", "einlage"].includes(r.kind)) return false;
    if (q) {
      const k = katById(x.kat);
      const hay = [x.notiz, k?.name, katMain(k)?.name, kontoById(x.konto)?.name, centIn(x.cent)].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return `${q ? "" : periodNav("liste")}
    <div class="toolbar"><input type="search" placeholder="Suchen (Notiz, Kategorie, Betrag)" value="${esc(ui.q)}" data-q></div>
    <div class="chips">${[["alle", "Alle"], ["aus", "Ausgaben"], ["ein", "Einnahmen"], ["um", "Umbuchungen"]].map(([k, l]) => `<button class="chip ${f === k ? "on" : ""}" data-filter="${k}">${l}</button>`).join("")}</div>
    ${list.length ? grouped(list, book) : `<div class="empty"><b>Keine Buchungen</b>${q ? "Nichts gefunden." : "In diesem Monat ist noch nichts eingetragen."}</div>`}`;
}

/* ---------- Auswertung ---------- */
const PALETTE = ["#4A4E69", "#C9ADA7", "#9A8C98", "#2F6B6F", "#D4A373", "#6D597A", "#8AA29E", "#B56576", "#E0C097", "#7D8597"];
function donut(parts, total) {
  if (!total) return "";
  const R = 70, C = 2 * Math.PI * R; let off = 0;
  const segs = parts.map((p, i) => { const len = p.cent / total * C; const s = `<circle r="${R}" cx="90" cy="90" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="26" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 90 90)"/>`; off += len; return s; }).join("");
  return `<div class="donut"><svg width="180" height="180" viewBox="0 0 180 180" role="img" aria-label="Ausgaben nach Kategorie">${segs}
    <text x="90" y="86" text-anchor="middle" font-size="12" fill="#7A7486">Ausgaben</text><text x="90" y="106" text-anchor="middle" font-size="17" font-weight="700" fill="#22223B">${esc(eur(total))}</text></svg></div>`;
}
function viewAuswertung() {
  const p = period(book, ui.off.auswertung), s = summary(book, p), prev = summary(book, period(book, ui.off.auswertung - 1));
  const ausAll = book === "privat" ? s.aus : s.aus;
  const parts = Object.values(s.byKat).filter((x) => x.typ === "aus").sort((a, b) => b.cent - a.cent);
  const ins = Object.values(s.byKat).filter((x) => x.typ === "ein").sort((a, b) => b.cent - a.cent);
  const diff = prev.aus ? (s.aus - prev.aus) / prev.aus : null;
  const fix = Object.values(s.byKat).filter((x) => x.typ === "aus").reduce((a, x) => a + Object.entries(x.subs).reduce((b, [kid, c]) => b + (katById(kid)?.fix ? c : 0), 0), 0);
  const legend = (arr, typ, total) => `<div class="list legend">${arr.map((x, i) => `<button class="item" data-act="katdetail" data-id="${x.main?.id || "-"}" data-typ="${typ}">
      ${typ === "aus" ? `<span class="sw" style="background:${PALETTE[i % PALETTE.length]}"></span>` : ""}<span class="ic">${x.main?.icon || "•"}</span>
      <span class="m"><span class="t">${esc(x.main?.name || "Ohne Kategorie")}</span><span class="bar"><i style="width:${total ? x.cent / total * 100 : 0}%"></i></span></span>
      <span class="v">${eur(x.cent)}<small>${total ? Math.round(x.cent / total * 100) : 0} %</small></span></button>`).join("")}</div>`;
  return `${periodNav("auswertung")}
    <div class="kpis"><div class="card"><div class="l">Einnahmen</div><div class="v in">${eur(s.ein)}</div></div>
      <div class="card"><div class="l">Ausgaben</div><div class="v out">${eur(s.aus)}</div></div>
      <div class="card"><div class="l">${book === "privat" ? "Saldo" : "Gewinn"}</div><div class="v">${eurS(s.saldo)}</div></div></div>
    ${diff != null ? `<div class="hint">Ausgaben ${diff > 0 ? "<b class=out>" + Math.round(diff * 100) + " % mehr</b>" : diff < 0 ? "<b class=in>" + Math.round(-diff * 100) + " % weniger</b>" : "genauso viel"} als im Vormonat (${eur(prev.aus)}).</div>` : ""}
    ${book === "gewerbe" && (s.entnahme || s.einlage) ? `<div class="card"><div class="row2"><div><div class="sub">Entnahmen (an Privat)</div><b>${eur(s.entnahme)}</b></div><div><div class="sub">Einlagen (von Privat)</div><b>${eur(s.einlage)}</b></div></div>
      <div class="sub" style="margin-top:6px">Nicht im Gewinn enthalten.</div></div>` : ""}
    <div class="h3"><span>Ausgaben nach Kategorie</span></div>
    ${parts.length ? `<div class="card">${donut(parts, ausAll)}${fix ? `<div class="sub" style="text-align:center;margin-bottom:8px">davon Fixkosten ${eur(fix)} · variabel ${eur(ausAll - fix)}</div>` : ""}${legend(parts, "aus", ausAll)}</div>` : `<div class="empty">Keine Ausgaben in diesem Monat.</div>`}
    <div class="h3"><span>Einnahmen nach Kategorie</span></div>
    ${ins.length ? `<div class="card">${legend(ins, "ein", s.ein)}</div>` : `<div class="empty">Keine Einnahmen in diesem Monat.</div>`}`;
}
function showKatDetail(mainId, typ) {
  const p = period(book, ui.off.auswertung);
  const main = katById(mainId);
  const gew = mainId === "__gew";
  const list = bookingsFor(book, (x) => { const r = relation(x, book); if (!inPeriod(x.datum, p)) return false;
    if (gew) return r.kind === (typ === "ein" ? "entnahme" : "einlage");
    const k = katById(x.kat); return r.kind === typ && (katMain(k)?.id || "-") === mainId; });
  modal({ title: `${gew ? (typ === "ein" ? "Aus dem Gewerbe" : "Ins Gewerbe") : main?.name || "Ohne Kategorie"} · ${p.label}`, body: list.length ? grouped(list, book) : `<div class="empty">Keine Buchungen.</div>` });
}

/* ---------- Mehr ---------- */
function viewMehr() {
  const conn = Sync.mode === "drive"
    ? `<p style="margin-top:0">Gespeichert in Google Drive${Sync.email ? ` (${esc(Sync.email)})` : ""}, Ordner „${esc(CFG.driveFolder)}“.</p>
       <div class="btns"><button class="btn small" data-act="sync-now">Jetzt abgleichen</button><button class="btn small ghost" data-act="logout">Abmelden</button></div>`
    : `<p style="margin-top:0">Die Daten liegen nur in diesem Browser.</p>${CFG.googleClientId ? `<button class="btn small primary" data-act="connect">Mit Google Drive verbinden</button>` : `<span class="sub">Google Drive ist noch nicht eingerichtet (config.js).</span>`}`;
  const item = (act, icon, t, s) => `<button class="item" data-act="${act}"><span class="ic">${icon}</span><span class="m"><span class="t">${t}</span><span class="s">${s}</span></span><span class="sub">›</span></button>`;
  return `<div class="h3"><span>${BOOKS[book]}</span></div><div class="list">
      ${item("konten", "🏦", "Konten", `${kontenOf(book).length} Konten · Anfangsbestand, Kassensturz`)}
      ${item("kategorien", "🗂️", "Kategorien", "umbenennen, ergänzen, ausblenden")}
      ${item("monat", "📅", "Abrechnungsmonat", `beginnt am ${db.settings[book].monatsStart}.`)}</div>
    <div class="h3"><span>Speicherort</span></div><div class="card">${conn}</div>
    <div class="h3"><span>Daten</span></div><div class="list">
      ${item("backup", "⬇️", "Sicherung herunterladen", "alle Daten als Datei")}
      ${item("restore", "⬆️", "Sicherung einspielen", "ersetzt die aktuellen Daten")}</div>
    <p class="sub" style="text-align:center;margin-top:20px">Haushaltsbuch · Stufe 1 · Stand ${new Date(db.updated).toLocaleString("de-DE")}</p>`;
}

/* =================================================================== Modals */
const stack = [];
function modal({ title, body, foot = "", full = false, cls = "", onClose }) {
  const bg = document.createElement("div"); bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal ${full ? "full" : ""} ${cls}" role="dialog" aria-modal="true">
    <div class="modal-h"><h2>${esc(title)}</h2><button class="x" data-close aria-label="Schließen">×</button></div>
    <div class="modal-b">${body}</div>${foot ? `<div class="modal-f">${foot}</div>` : ""}</div>`;
  $("#modals").appendChild(bg); stack.push(bg); bg.onClose = onClose;
  bg.addEventListener("click", (e) => { if (e.target === bg || e.target.closest("[data-close]")) closeModal(bg); });
  document.body.style.overflow = "hidden";
  return bg;
}
function closeModal(bg = stack[stack.length - 1]) {
  if (!bg) return;
  const i = stack.indexOf(bg); if (i >= 0) stack.splice(i, 1);
  bg.remove(); const cb = bg.onClose; bg.onClose = null; cb && cb();
  if (!stack.length) document.body.style.overflow = "";
}
function closeAll() { while (stack.length) closeModal(); }
function confirmBox(title, text, okLabel = "OK", danger = false) {
  return new Promise((res) => {
    const m = modal({ title, body: `<p style="margin-top:0">${text}</p>`, foot: `<button class="btn" data-close>Abbrechen</button><button class="btn ${danger ? "danger" : "primary"}" data-ok>${esc(okLabel)}</button>`, onClose: () => res(false) });
    $("[data-ok]", m).onclick = () => { m.onClose = null; closeModal(m); res(true); };
  });
}
function readForm(form) { const o = {}; new FormData(form).forEach((v, k) => (o[k] = typeof v === "string" ? v.trim() : v)); return o; }

/* Konto auswählen. Im Gewerbe zusätzlich private Konten („privat bezahlt/erhalten“). */
function pickKonto({ title, b, art, all }) {
  return new Promise((res) => {
    const groups = [];
    if (all) { groups.push(["Privat", kontenOf("privat")]); groups.push(["Gewerbe", kontenOf("gewerbe")]); }
    else {
      groups.push([BOOKS[b], kontenOf(b)]);
      if (b === "gewerbe") groups.push([art === "ein" ? "Privat erhalten auf" : "Privat bezahlt mit", kontenOf("privat")]);
    }
    const m = modal({ title, onClose: () => res(null), body: groups.filter((g) => g[1].length).map(([g, ks]) => `<div class="pick-group">${esc(g)}</div><div class="list">${ks.map((k) => `<button class="item" data-k="${k.id}"><span class="ic">${ART_ICON[k.art]}</span><span class="m"><span class="t">${esc(k.name)}</span></span><span class="v">${eur(balance(k.id))}</span></button>`).join("")}</div>`).join("") || `<div class="empty">Noch keine Konten.</div>` });
    m.addEventListener("click", (e) => { const b2 = e.target.closest("[data-k]"); if (b2) { m.onClose = null; closeModal(m); res(b2.dataset.k); } });
  });
}
/* Alle Kategorien zur Auswahl, gruppiert */
function pickKat(b, typ) {
  return new Promise((res) => {
    const mains = db.kategorien.filter((k) => k.buch === b && k.typ === typ && !k.parent && !k.hidden);
    const m = modal({ title: "Kategorie wählen", onClose: () => res(null), body: mains.map((mk) => {
      const subs = db.kategorien.filter((k) => k.parent === mk.id && !k.hidden);
      return `<div class="pick-group">${mk.icon} ${esc(mk.name)}</div><div class="pick-sub">${(subs.length ? subs : [mk]).map((k) => `<button data-k="${k.id}">${esc(k.name)}</button>`).join("")}</div>`;
    }).join("") });
    m.addEventListener("click", (e) => { const b2 = e.target.closest("[data-k]"); if (b2) { m.onClose = null; closeModal(m); res(b2.dataset.k); } });
  });
}

/* =================================================================== Erfassen */
function defaultKonto(b, art) {
  const last = db.settings.last[b + "-" + art] || db.settings.last[b];
  if (last && kontoById(last) && !kontoById(last).archiv) return last;
  return (kontenOf(b)[0] || (b === "gewerbe" ? kontenOf("privat")[0] : null))?.id || null;
}
function openEntry(opts = {}) {
  const editing = opts.id ? db.buchungen.find((x) => x.id === opts.id) : null;
  const st = editing ? { art: editing.art, b: editing.buch, amt: centIn(editing.cent), konto: editing.konto, ziel: editing.ziel || null, kat: editing.kat || null, datum: editing.datum, notiz: editing.notiz || "" }
    : { art: opts.art || "aus", b: book, amt: "", konto: null, ziel: null, kat: null, datum: todayISO(), notiz: "" };
  if (!editing) { st.konto = defaultKonto(st.b, st.art); }
  if (st.art === "um" && !st.ziel) st.ziel = kontenOf(st.b).find((k) => k.id !== st.konto)?.id || null;
  const sales = () => db.buchungen.filter((x) => x.buch === "gewerbe" && x.art === "ein" && x.datum === todayISO());
  const m = modal({ title: editing ? "Buchung bearbeiten" : `Neue Buchung · ${BOOKS[st.b]}`, full: true, cls: "entry", body: `<div data-body style="display:contents"></div>` });
  const cents = () => { const c = toCent(st.amt); return c && c > 0 ? c : 0; };
  const draw = () => {
    const konto = kontoById(st.konto), ziel = kontoById(st.ziel);
    const cross = konto && konto.buch !== st.b;
    const kontoLabel = konto ? (cross ? `privat ${st.art === "ein" ? "erhalten" : "bezahlt"}: ${konto.name}` : konto.name) : "Konto wählen";
    const tiles = st.art === "um" ? "" : (() => {
      const list = tileCats(st.b, st.art);
      if (st.kat && !list.some((k) => k.id === st.kat) && katById(st.kat)) list.unshift(katById(st.kat));
      return `<div class="tiles">${list.slice(0, 7).map((k) => `<button class="tile ${st.kat === k.id ? "on" : ""}" data-tile="${k.id}"><span class="e">${katIcon(k)}</span><span class="n">${esc(k.name)}</span></button>`).join("")}
        <button class="tile all" data-tile="__all"><span class="e">⋯</span><span class="n">Alle</span></button></div>`;
    })();
    $("[data-body]", m).innerHTML = `
      <div class="seg">${[["aus", "Ausgabe"], ["ein", "Einnahme"], ["um", "Umbuchung"]].map(([k, l]) => `<button data-art="${k}" class="${st.art === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="amount" data-amount><div class="a ${cents() ? "" : "zero"}">${st.amt ? esc(st.amt) : "0"} €</div></div>
      ${st.art === "um" ? `<div class="transfer">
          <button class="pickbtn" data-pick="konto"><small>Von</small>${esc(konto?.name || "Konto wählen")} <span class="sub">${konto ? BOOKS[konto.buch] : ""}</span></button>
          <button class="pickbtn" data-pick="ziel"><small>Nach</small>${esc(ziel?.name || "Konto wählen")} <span class="sub">${ziel ? BOOKS[ziel.buch] : ""}</span></button>
          ${konto && ziel && konto.buch !== ziel.buch ? `<div class="hint" style="margin:0">${konto.buch === "gewerbe" ? "Entnahme: Geld vom Gewerbe ins Private." : "Einlage: privates Geld ins Gewerbe."}</div>` : ""}</div>` : ""}
      <div class="meta">
        ${st.art !== "um" ? `<button class="chip" data-pick="konto">${ART_ICON[konto?.art] || "💳"} ${esc(kontoLabel)}</button>` : ""}
        <button class="chip" data-datebtn>📅 ${esc(dayLabel(st.datum))}</button><input type="date" value="${esc(st.datum)}" data-date aria-label="Datum" style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px">
        <button class="chip" data-notiz>${st.notiz ? "📝 " + esc(st.notiz) : "+ Notiz"}</button>
      </div>
      ${tiles}
      ${st.b === "gewerbe" && st.art === "ein" && !editing ? `<div class="sales">Heute: ${sales().length} Verkäufe · ${eur(sales().reduce((a, x) => a + x.cent, 0))}</div>` : ""}
      <div class="keypad">${["1", "2", "3", "4", "5", "6", "7", "8", "9", ",", "0", "⌫"].map((k) => `<button data-key="${k}">${k}</button>`).join("")}
        ${editing || st.art === "um" ? `<button class="go" data-save>${editing ? "Speichern" : "Umbuchen"}</button>` : ""}
        ${editing ? `<button class="btn danger" data-del style="grid-column:span 3">Löschen</button>` : ""}</div>`;
  };
  const bump = () => { const a = $("[data-amount]", m); a.classList.remove("shake"); void a.offsetWidth; a.classList.add("shake"); };
  const save = () => {
    const c = cents();
    if (!c) { bump(); return toast("Erst den Betrag tippen"); }
    if (!st.konto) return toast("Bitte ein Konto wählen");
    if (st.art !== "um" && !st.kat) return toast("Bitte eine Kategorie wählen");
    if (st.art === "um" && (!st.ziel || st.ziel === st.konto)) return toast("Bitte zwei verschiedene Konten wählen");
    const x = editing || { id: uid(), created: new Date().toISOString() };
    Object.assign(x, { art: st.art, buch: st.art === "um" ? kontoBook(st.konto) : st.b, cent: c, konto: st.konto, datum: st.datum || todayISO(), notiz: st.notiz });
    if (st.art === "um") { x.ziel = st.ziel; delete x.kat; } else { x.kat = st.kat; delete x.ziel; }
    if (!editing) db.buchungen.push(x);
    db.settings.last[st.b + "-" + st.art] = st.konto;
    Sync.changed(); render();
    const k = katById(x.kat);
    const msg = `${eur(c)} ${st.art === "um" ? "umgebucht" : (k ? k.name : "")} gespeichert`;
    if (editing) { closeModal(m); return toast("Änderung gespeichert"); }
    toast(msg, { label: "Rückgängig", fn: () => { db.buchungen = db.buchungen.filter((y) => y.id !== x.id); Sync.changed(); render(); toast("Buchung entfernt"); } });
    if (st.b === "gewerbe" && st.art === "ein") { st.amt = ""; st.notiz = ""; draw(); }   // Verkaufsmodus: gleich weiter
    else closeModal(m);
  };
  draw();
  m.addEventListener("click", async (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.key) {
      const k = t.dataset.key;
      if (k === "⌫") st.amt = st.amt.slice(0, -1);
      else if (k === ",") { if (!st.amt.includes(",")) st.amt = (st.amt || "0") + ","; }
      else { const [, dec] = st.amt.split(","); if (dec != null && dec.length >= 2) return; if (st.amt.replace(",", "").length >= 8) return; st.amt = st.amt === "0" ? k : st.amt + k; }
      return draw();
    }
    if (t.dataset.art) {
      st.art = t.dataset.art; st.kat = null;
      if (!editing) st.konto = defaultKonto(st.b, st.art);
      if (st.art === "um") { if (kontoBook(st.konto) !== st.b) st.konto = kontenOf(st.b)[0]?.id || kontenOf("privat")[0]?.id; st.ziel = db.konten.find((k) => !k.archiv && k.id !== st.konto)?.id || null; }
      return draw();
    }
    if (t.dataset.tile) {
      if (t.dataset.tile === "__all") { const k = await pickKat(st.b, st.art); if (!k) return; st.kat = k; }
      else st.kat = t.dataset.tile;
      if (editing) return draw();
      return save();   // Kachel antippen = speichern
    }
    if (t.dataset.pick) {
      const id = await pickKonto({ title: t.dataset.pick === "ziel" ? "Nach Konto" : st.art === "um" ? "Von Konto" : "Konto", b: st.b, art: st.art, all: st.art === "um" });
      if (id) { st[t.dataset.pick] = id; draw(); }
      return;
    }
    if (t.hasAttribute("data-notiz")) {
      const v = await promptBox("Notiz", st.notiz, "z. B. Wocheneinkauf"); if (v != null) { st.notiz = v; draw(); }
      return;
    }
    if (t.hasAttribute("data-datebtn")) { const d = $("[data-date]", m); try { d.showPicker(); } catch { d.focus(); d.click(); } return; }
    if (t.hasAttribute("data-save")) return save();
    if (t.hasAttribute("data-del")) {
      if (!await confirmBox("Buchung löschen?", "Die Buchung wird entfernt.", "Löschen", true)) return;
      const copy = clone(editing);
      db.buchungen = db.buchungen.filter((y) => y.id !== editing.id); Sync.changed(); closeModal(m); render();
      toast("Buchung gelöscht", { label: "Rückgängig", fn: () => { db.buchungen.push(copy); Sync.changed(); render(); } });
    }
  });
  m.addEventListener("change", (e) => { if (e.target.matches("[data-date]")) { st.datum = e.target.value || todayISO(); draw(); } });
}
function promptBox(title, value = "", placeholder = "") {
  return new Promise((res) => {
    const m = modal({ title, onClose: () => res(null), body: `<input data-in value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="80">`,
      foot: `<button class="btn" data-close>Abbrechen</button><button class="btn primary" data-ok>Übernehmen</button>` });
    const inp = $("[data-in]", m); setTimeout(() => inp.focus(), 50);
    const ok = () => { m.onClose = null; closeModal(m); res(inp.value.trim()); };
    $("[data-ok]", m).onclick = ok; inp.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
  });
}

/* =================================================================== Konten */
function showKonto(id) {
  const k = kontoById(id); const bal = balance(id);
  const list = db.buchungen.filter((x) => x.konto === id || x.ziel === id).sort((a, c) => c.datum.localeCompare(a.datum)).slice(0, 60);
  const m = modal({ title: k.name, body: `<div class="card hero"><div class="l">Kontostand</div><div class="big">${eur(bal)}</div>
      <div class="l">Anfangsbestand ${eur(k.start)} am ${fDate(k.startDatum)}</div></div>
      <div class="btns" style="margin-bottom:8px">${k.art === "bar" ? `<button class="btn" data-kasse>Kassensturz</button>` : ""}<button class="btn" data-edit>Bearbeiten</button></div>
      ${list.length ? grouped(list, k.buch) : `<div class="empty">Noch keine Buchungen auf diesem Konto.</div>`}` });
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-edit]")) { closeModal(m); editKonto(id); }
    if (e.target.closest("[data-kasse]")) { closeModal(m); kassensturz(id); }
    const ed = e.target.closest("[data-act=edit]"); if (ed) { e.stopPropagation(); closeModal(m); openEntry({ id: ed.dataset.id }); }
  });
}
async function kassensturz(id) {
  const k = kontoById(id), bal = balance(id);
  const v = await promptBox(`Kassensturz ${k.name}`, "", `Wie viel ist gerade drin? (laut App ${centIn(bal)} €)`);
  if (v == null) return;
  const ist = toCent(v); if (ist == null) return toast("Bitte einen Betrag eingeben");
  const diff = ist - bal;
  if (!diff) return toast("Stimmt genau – nichts zu buchen");
  const typ = diff < 0 ? "aus" : "ein";
  const mains = db.kategorien.filter((c) => c.buch === k.buch && c.typ === typ && !c.hidden);
  const kat = mains.find((c) => c.name === "Sonstiges" && !hasChildren(c.id)) || mains.find((c) => c.name === "Sonstiges") || leafCats(k.buch, typ)[0];
  db.buchungen.push({ id: uid(), created: new Date().toISOString(), art: typ, buch: k.buch, cent: Math.abs(diff), konto: id, kat: kat?.id, datum: todayISO(), notiz: "Kassensturz" });
  Sync.changed(); render(); toast(`Differenz ${eurS(diff)} gebucht`);
}
function editKonto(id) {
  const isNew = !id;
  const k = isNew ? { id: nextKontoId(), name: "", buch: book, art: "giro", start: 0, startDatum: todayISO(), archiv: false } : clone(kontoById(id));
  const used = !isNew && db.buchungen.some((x) => x.konto === id || x.ziel === id);
  const m = modal({ title: isNew ? `Neues Konto · ${BOOKS[k.buch]}` : k.name, body: `<form data-f>
      <label class="f"><span>Name</span><input name="name" value="${esc(k.name)}" placeholder="z. B. Geschäftskonto"></label>
      <label class="f"><span>Art</span><select name="art">${Object.entries(ART_KONTO).map(([a, l]) => `<option value="${a}" ${k.art === a ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <div class="row2"><label class="f"><span>Anfangsbestand €</span><input name="start" inputmode="decimal" value="${centIn(k.start)}"></label>
      <label class="f"><span>am</span><input name="startDatum" type="date" value="${esc(k.startDatum)}"></label></div>
      ${!isNew ? `<label class="f"><span><input type="checkbox" name="archiv" ${k.archiv ? "checked" : ""} style="width:auto;min-height:0"> Konto ausblenden (z. B. aufgelöst)</span></label>` : ""}</form>`,
    foot: `${!isNew ? `<button class="btn danger" data-del>Löschen</button>` : ""}<button class="btn primary" data-save>Speichern</button>` });
  $("[data-save]", m).onclick = () => {
    const f = readForm($("[data-f]", m));
    if (!f.name) return toast("Bitte einen Namen eingeben");
    Object.assign(k, { name: f.name, art: f.art, start: toCent(f.start) || 0, startDatum: f.startDatum || todayISO(), archiv: !!f.archiv });
    if (isNew) db.konten.push(k); else db.konten[db.konten.findIndex((x) => x.id === k.id)] = k;
    Sync.changed(); closeModal(m); render(); toast("Konto gespeichert");
  };
  if (!isNew) $("[data-del]", m).onclick = async () => {
    if (used) return toast("Auf diesem Konto gibt es Buchungen – stattdessen ausblenden.");
    if (!await confirmBox("Konto löschen?", `„${esc(k.name)}“ wird gelöscht.`, "Löschen", true)) return;
    db.konten = db.konten.filter((x) => x.id !== k.id); Sync.changed(); closeModal(m); render();
  };
}
function showKonten() {
  const m = modal({ title: `Konten · ${BOOKS[book]}`, body: `${kontenOf(book, true).length ? `<div class="list">${kontenOf(book, true).map((k) => `<button class="item" data-k="${k.id}"><span class="ic">${ART_ICON[k.art]}</span><span class="m"><span class="t">${esc(k.name)}${k.archiv ? ' <span class="tag">ausgeblendet</span>' : ""}</span><span class="s">Anfangsbestand ${eur(k.start)} am ${fDate(k.startDatum)}</span></span><span class="v">${eur(balance(k.id))}</span></button>`).join("")}</div>` : `<div class="empty">Noch keine Konten.</div>`}`,
    foot: `<button class="btn primary" data-new>+ Konto anlegen</button>` });
  m.addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]"); if (b) { closeModal(m); editKonto(b.dataset.k); }
    if (e.target.closest("[data-new]")) { closeModal(m); editKonto(null); }
  });
}

/* =================================================================== Kategorien */
function showKategorien(typ = "aus") {
  const mains = db.kategorien.filter((k) => k.buch === book && k.typ === typ && !k.parent);
  const m = modal({ title: `Kategorien · ${BOOKS[book]}`, body: `<div class="seg" style="grid-template-columns:1fr 1fr;margin-bottom:12px"><button data-typ="aus" class="${typ === "aus" ? "on" : ""}">Ausgaben</button><button data-typ="ein" class="${typ === "ein" ? "on" : ""}">Einnahmen</button></div>
    ${mains.map((mk) => `<div class="pick-group">${mk.icon} ${esc(mk.name)}${mk.hidden ? ' <span class="tag">aus</span>' : ""}</div><div class="list">
      <button class="item" data-k="${mk.id}"><span class="m"><span class="t">${esc(mk.name)}</span><span class="s">Hauptkategorie${mk.fix ? " · fix" : ""}</span></span><span class="sub">›</span></button>
      ${db.kategorien.filter((k) => k.parent === mk.id).map((k) => `<button class="item" data-k="${k.id}"><span class="m"><span class="t">${esc(k.name)}${k.hidden ? ' <span class="tag">aus</span>' : ""}</span><span class="s">${k.fix ? "fix" : "variabel"}</span></span><span class="sub">›</span></button>`).join("")}
      <button class="item" data-newsub="${mk.id}"><span class="m"><span class="t" style="color:var(--acc)">+ Unterkategorie</span></span></button></div>`).join("")}`,
    foot: `<button class="btn primary" data-newmain>+ Hauptkategorie</button>` });
  m.addEventListener("click", (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.typ) { closeModal(m); showKategorien(t.dataset.typ); }
    if (t.dataset.k) { closeModal(m); editKat(t.dataset.k, null, typ); }
    if (t.dataset.newsub) { closeModal(m); editKat(null, t.dataset.newsub, typ); }
    if (t.hasAttribute("data-newmain")) { closeModal(m); editKat(null, null, typ); }
  });
}
function editKat(id, parent, typ) {
  const isNew = !id;
  const k = isNew ? { id: nextKatId(), buch: book, typ, name: "", icon: parent ? katById(parent).icon : "📦", fix: parent ? katById(parent).fix : false, parent, hidden: false } : clone(katById(id));
  const used = db.buchungen.filter((x) => x.kat === k.id).length;
  const m = modal({ title: isNew ? (parent ? "Neue Unterkategorie" : "Neue Hauptkategorie") : k.name, body: `<form data-f>
      <div class="row2" style="grid-template-columns:${k.parent ? "1fr" : "1fr 90px"}"><label class="f"><span>Name</span><input name="name" value="${esc(k.name)}"></label>
      ${k.parent ? "" : `<label class="f"><span>Symbol</span><input name="icon" value="${esc(k.icon)}" maxlength="4" style="text-align:center;font-size:20px"></label>`}</div>
      <label class="f"><span>Art</span><select name="fix"><option value="0" ${!k.fix ? "selected" : ""}>variabel</option><option value="1" ${k.fix ? "selected" : ""}>fix (jeden Monat gleich)</option></select></label>
      ${!isNew ? `<label class="f"><span><input type="checkbox" name="hidden" ${k.hidden ? "checked" : ""} style="width:auto;min-height:0"> ausblenden (erscheint nicht mehr zur Auswahl)</span></label>` : ""}
      ${used ? `<p class="sub">${used} Buchungen verwenden diese Kategorie.</p>` : ""}</form>`,
    foot: `${!isNew && !used && !hasChildren(k.id) ? `<button class="btn danger" data-del>Löschen</button>` : ""}<button class="btn primary" data-save>Speichern</button>`,
    onClose: () => showKategorien(typ) });
  $("[data-save]", m).onclick = () => {
    const f = readForm($("[data-f]", m)); if (!f.name) return toast("Bitte einen Namen eingeben");
    Object.assign(k, { name: f.name, fix: f.fix === "1", hidden: !!f.hidden }); if (f.icon) k.icon = f.icon;
    if (isNew) db.kategorien.push(k); else db.kategorien[db.kategorien.findIndex((x) => x.id === k.id)] = k;
    if (!k.parent) db.kategorien.forEach((c) => { if (c.parent === k.id) c.icon = k.icon; });
    Sync.changed(); closeModal(m); render();
  };
  const del = $("[data-del]", m);
  if (del) del.onclick = async () => { m.onClose = null; closeModal(m); if (await confirmBox("Kategorie löschen?", `„${esc(k.name)}“ wird gelöscht.`, "Löschen", true)) { db.kategorien = db.kategorien.filter((x) => x.id !== k.id); Sync.changed(); render(); } showKategorien(typ); };
}
function editMonat() {
  const m = modal({ title: `Abrechnungsmonat · ${BOOKS[book]}`, body: `<p style="margin-top:0">Der Monat beginnt am:</p>
      <select data-s>${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${db.settings[book].monatsStart === i + 1 ? "selected" : ""}>${i + 1}.${i === 0 ? " (Kalendermonat)" : ""}</option>`).join("")}</select>
      <p class="sub">Beispiel 27.: Der Monat „Dezember“ läuft vom 27. November bis 26. Dezember.</p>`,
    foot: `<button class="btn primary" data-save>Speichern</button>` });
  $("[data-save]", m).onclick = () => { db.settings[book].monatsStart = +$("[data-s]", m).value; Sync.changed(); closeModal(m); render(); };
}

/* =================================================================== Willkommen & Start */
function welcome() {
  $("#app").innerHTML = `<div class="welcome"><img src="icons/icon.svg" alt=""><h1>Haushaltsbuch</h1>
    <p>Ausgaben in Sekunden eintragen – privat und gewerblich getrennt.</p>
    ${CFG.googleClientId ? `<button class="btn primary" data-act="connect">Mit Google Drive verbinden</button>
      <p class="sub">Die Daten werden in deinem Google Drive im Ordner „${esc(CFG.driveFolder)}“ gespeichert.</p>` : `<div class="hint">Google Drive ist noch nicht eingerichtet (Client-ID in config.js fehlt).</div>`}
    <button class="btn" data-act="local">${CFG.googleClientId ? "Ohne Konto ausprobieren" : "Starten (nur auf diesem Gerät)"}</button></div>`;
}
function onboarding() {
  if (db.settings.onboarded) return;
  const ks = kontenOf("privat");
  const m = modal({ title: "Willkommen!", body: `<p style="margin-top:0">Wie viel ist gerade auf deinen Konten? Dann stimmen die Kontostände von Anfang an.</p>
      <form data-f>${ks.map((k) => `<label class="f"><span>${ART_ICON[k.art]} ${esc(k.name)}</span><input name="${k.id}" inputmode="decimal" placeholder="0,00"></label>`).join("")}</form>
      <p class="sub">Später änderbar unter Mehr → Konten. Die Gewerbe-Konten legst du an, sobald sie eröffnet sind.</p>`,
    foot: `<button class="btn primary" data-ok>Los geht’s</button>`, onClose: () => { db.settings.onboarded = true; Sync.changed(); } });
  $("[data-ok]", m).onclick = () => {
    const f = readForm($("[data-f]", m));
    ks.forEach((k) => { k.start = toCent(f[k.id]) || 0; k.startDatum = todayISO(); });
    closeModal(m); render();
  };
}
function startApp() {
  renderShell(); render(); onboarding();
  const neu = new URLSearchParams(location.search).get("neu");
  if (neu) { history.replaceState(null, "", location.pathname); openEntry({ art: neu === "ein" ? "ein" : "aus" }); }
}
async function connectDrive() {
  try {
    toast("Verbinde mit Google Drive …");
    const hadLocal = Sync.mode === "local" && db && db.buchungen.length;
    const st = await Sync.connect(true);
    let useLocal = false;
    if (st === "exists" && hadLocal) useLocal = await confirmBox("Welche Daten verwenden?", "In Google Drive gibt es bereits Daten und auf diesem Gerät auch. Daten <b>von diesem Gerät</b> nach Drive übernehmen? (Sonst werden die Drive-Daten geladen.)", "Von diesem Gerät übernehmen");
    if (st === "exists" && !useLocal) { db = migrate(await Sync.pull()); Sync.dirty = false; }
    else { if (!db) db = emptyDB(); if (st === "missing") await Sync.createFile(db); Sync.dirty = true; }
    Sync.mode = "drive"; lsSet(LS.mode, "drive"); Sync.saveCache();
    if (Sync.dirty) await Sync.push(true); else Sync.setStatus("saved");
    toast("Mit Google Drive verbunden"); startApp();
  } catch (e) { console.error(e); toast(e.message || "Verbindung fehlgeschlagen"); }
}
function conflictDialog() {
  Sync.setStatus("error");
  const m = modal({ title: "Daten wurden woanders geändert", body: `<p style="margin-top:0">Die Datei in Google Drive wurde inzwischen von einem anderen Gerät gespeichert.</p>
      <p><b>Andere Version laden:</b> deine letzten Änderungen hier gehen verloren.<br><b>Meine Version behalten:</b> die Änderungen vom anderen Gerät werden überschrieben.</p>`,
    foot: `<button class="btn" data-theirs>Andere laden</button><button class="btn primary" data-mine>Meine behalten</button>` });
  $("[data-theirs]", m).onclick = async () => { closeModal(m); db = migrate(await Sync.pull()); Sync.dirty = false; Sync.saveCache(); Sync.setStatus("saved"); render(); };
  $("[data-mine]", m).onclick = () => { closeModal(m); Sync.push(true); };
}
function download(name, blob) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function restoreBackup() {
  const i = document.createElement("input"); i.type = "file"; i.accept = ".json,application/json";
  i.onchange = async () => {
    try {
      const d = JSON.parse(await i.files[0].text()); if (!Array.isArray(d.buchungen)) throw new Error("keine Haushaltsbuch-Sicherung");
      if (!await confirmBox("Sicherung einspielen?", `Die aktuellen Daten werden durch die Sicherung vom ${new Date(d.updated).toLocaleString("de-DE")} ersetzt.`, "Einspielen", true)) return;
      db = migrate(d); Sync.changed(); render(); toast("Sicherung eingespielt");
    } catch (e) { toast("Datei konnte nicht gelesen werden: " + e.message); }
  };
  i.click();
}

/* =================================================================== Ereignisse */
document.addEventListener("click", async (e) => {
  if (e.target.closest(".modal-bg") && !e.target.closest("[data-act=edit]")) return;   // Modals regeln ihre Klicks selbst
  const bk = e.target.closest("[data-book]");
  if (bk && bk.closest(".switch")) { book = bk.dataset.book; lsSet(LS.book, book); ui.off = { liste: 0, auswertung: 0 }; return render(); }
  const tb = e.target.closest("[data-tab]"); if (tb) { e.preventDefault(); return go(tb.dataset.tab); }
  const fl = e.target.closest("[data-filter]"); if (fl) { ui.filter = fl.dataset.filter; return render(); }
  const a = e.target.closest("[data-act]"); if (!a) return;
  const id = a.dataset.id;
  switch (a.dataset.act) {
    case "connect": return connectDrive();
    case "local": Sync.mode = "local"; lsSet(LS.mode, "local"); db = db || emptyDB(); Sync.saveCache(); return startApp();
    case "neu": return openEntry({});
    case "edit": closeAll(); return openEntry({ id });
    case "konto": return showKonto(id);
    case "konten": return showKonten();
    case "kategorien": return showKategorien("aus");
    case "monat": return editMonat();
    case "katdetail": return showKatDetail(id, a.dataset.typ);
    case "prev": ui.off[a.dataset.k]--; return render();
    case "next": ui.off[a.dataset.k] = Math.min(0, ui.off[a.dataset.k] + 1); return render();
    case "backup": return download(`Haushaltsbuch_Sicherung_${todayISO()}.json`, new Blob([JSON.stringify(db, null, 1)], { type: "application/json" }));
    case "restore": return restoreBackup();
    case "sync": case "sync-now":
      if (Sync.mode !== "drive") return go("mehr");
      if (Sync.status === "auth") { try { await Sync.getToken(true); } catch (err) { return toast(err.message); } }
      if (Sync.dirty) return Sync.push();
      return Sync.refresh().then(() => toast("Daten sind aktuell"));
    case "logout":
      if (!await confirmBox("Abmelden?", "Die App wird auf diesem Gerät von Google Drive getrennt. Die Daten in Drive bleiben erhalten.", "Abmelden")) return;
      if (Sync.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(Sync.token, () => {});
      [LS.data, LS.meta, LS.mode, LS.token].forEach(lsDel); location.reload();
  }
});
document.addEventListener("input", (e) => {
  if (e.target.matches("[data-q]")) { ui.q = e.target.value; const pos = e.target.selectionStart; render(); const el = $("[data-q]"); el.focus(); el.setSelectionRange(pos, pos); }
});
window.addEventListener("online", () => { if (Sync.mode === "drive") Sync.push(); });
window.addEventListener("offline", () => Sync.mode === "drive" && Sync.setStatus("offline"));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { if (Sync.dirty) Sync.push(); else Sync.refresh(); render(); } });

/* =================================================================== Init */
(async function init() {
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  const cached = Sync.loadCache();
  db = cached ? migrate(cached) : null;
  if (!Sync.mode) return welcome();
  if (!db) db = emptyDB();
  startApp();
  if (Sync.mode === "drive") {
    if (Sync.dirty) return Sync.push();
    if (!navigator.onLine) return Sync.setStatus("offline");
    try {
      if (!Sync.fileId) { const st = await Sync.connect(false); if (st === "missing") await Sync.createFile(db); }
      if (await Sync.checksum() !== Sync.version) { db = migrate(await Sync.pull()); Sync.saveCache(); render(); }
      Sync.setStatus("saved");
    } catch (e) { Sync.setStatus(e.auth ? "auth" : "error"); }
  }
})();
