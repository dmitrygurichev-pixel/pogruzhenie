/* Полное погружение — мессенджер курса. Один файл, без сборки. */
"use strict";
const pb = new PocketBase(location.origin);
pb.autoCancellation(false);

const $view = document.getElementById("view");
const $overlay = document.getElementById("overlay");
const S = { users: {}, teacher: null, me: null, unsub: null, thread: null, installEvt: null };

/* ---------- утилиты ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const md = (s) => DOMPurify.sanitize(marked.parse(s || "", { breaks: true }), { ADD_ATTR: ["target"] });
const isTeacher = () => S.me?.role === "teacher";
const parseDate = (s) => (s ? new Date(String(s).replace(" ", "T")) : null);
const TZ = "Europe/Moscow";
function fmt(s, opts) { const d = parseDate(s); return d ? d.toLocaleString("ru-RU", { timeZone: TZ, ...opts }) : ""; }
const fmtDay = (s) => fmt(s, { day: "numeric", month: "long" });
const fmtDayTime = (s) => fmt(s, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const fmtTime = (s) => fmt(s, { hour: "2-digit", minute: "2-digit" });
// поле datetime-local всегда по Москве (UTC+3, без перехода на летнее время)
const mskToISO = (v) => (v ? new Date(v + ":00+03:00").toISOString() : "");
const isoToMsk = (s) => { const d = parseDate(s); return d ? new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 16) : ""; };
const nowISO = () => new Date().toISOString().replace("T", " ");
const name = (id) => S.users[id]?.name || "Участник";
const initials = (n) => (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const fileUrl = (rec, f, thumb) => pb.files.getURL(rec, f, thumb ? { thumb } : undefined);
const isImg = (f) => /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f);
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}
function errText(e) {
  const r = e?.response || {};
  if (r.data && Object.keys(r.data).length) {
    const [field, v] = Object.entries(r.data)[0];
    if (v.code === "validation_not_unique" && field === "email") return "Этот email уже зарегистрирован. Войдите.";
    if (field === "password" && v.code === "validation_length_out_of_range") return "Пароль — минимум 8 символов.";
    if (field === "email") return "Проверьте email.";
    if (v.code === "validation_file_size_limit") return "Файл слишком большой.";
    if (v.code === "validation_invalid_mime_type") return "Этот тип файла не поддерживается.";
    return v.message || r.message;
  }
  if (r.message === "Failed to authenticate.") return "Неверный email или пароль.";
  if (e?.status === 0) return "Нет связи с сервером. Проверьте интернет.";
  return r.message || "Что-то пошло не так. Попробуйте ещё раз.";
}
function statusOf(sub, lesson) {
  if (sub) return { submitted: ["submitted", "На проверке"], reviewed: ["reviewed", "Принято"], redo: ["redo", "Нужно доработать"] }[sub.status] || ["submitted", "На проверке"];
  if (lesson?.due_at && parseDate(lesson.due_at) < new Date()) return ["late", "Срок прошёл"];
  return ["none", "Не сдано"];
}
/* Сжатие фото на телефоне перед отправкой: длинная сторона до 2048 px, JPEG ~80%.
   Снимок 5–10 МБ превращается примерно в 300–500 КБ. Если сжать не вышло — уходит оригинал. */
async function compressImage(file) {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.size < 600 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch (_) { return file; }
}
const compressAll = (files) => Promise.all(files.map(compressImage));
function openOverlay(html, cls = "") {
  $overlay.className = "overlay " + cls; $overlay.innerHTML = html; $overlay.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeOverlay() { $overlay.hidden = true; $overlay.innerHTML = ""; document.body.style.overflow = ""; }
$overlay.addEventListener("click", (e) => { if (e.target === $overlay || e.target.closest("[data-close]")) closeOverlay(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$overlay.hidden) closeOverlay(); });
document.addEventListener("click", (e) => {
  const img = e.target.closest("img[data-full]");
  if (img) openOverlay(`<img src="${esc(img.dataset.full)}" alt="">`, "lightbox");
});

/* ---------- вход и регистрация ---------- */
const inviteCode = new URLSearchParams(location.search).get("invite");
function renderAuth(mode) {
  mode = mode || (inviteCode ? "signup" : "login");
  document.getElementById("tabbar").hidden = true;
  document.getElementById("meBtn").hidden = true;
  $view.className = "view no-tabs";
  $view.innerHTML = `
  <div class="auth">
    <div class="block">
      <h1>Полное погружение</h1>
      <div>Курс по основам фотографии с Дмитрием Гуричевым. Чат группы, памятки и домашние задания — здесь.</div>
    </div>
    <div class="switch" role="tablist">
      <button type="button" data-mode="login" class="${mode === "login" ? "on" : ""}">Вход</button>
      <button type="button" data-mode="signup" class="${mode === "signup" ? "on" : ""}">Регистрация</button>
    </div>
    <form id="authForm" novalidate>
      ${mode === "signup" ? `<label class="field"><span>Имя и фамилия</span><input class="in" name="name" autocomplete="name" required></label>` : ""}
      <label class="field"><span>Email</span><input class="in" name="email" type="email" autocomplete="email" inputmode="email" required></label>
      <label class="field"><span>Пароль</span><input class="in" name="password" type="password" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" required>
        ${mode === "signup" ? `<div class="hint">Минимум 8 символов</div>` : ""}</label>
      ${mode === "signup" && !inviteCode ? `<div class="hint" style="margin-bottom:14px">Зарегистрироваться можно по ссылке-приглашению от преподавателя.</div>` : ""}
      <div class="err" id="authErr" hidden></div>
      <button class="btn dark wide" type="submit">${mode === "signup" ? "Создать аккаунт" : "Войти"}</button>
    </form>
  </div>`;
  $view.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => renderAuth(b.dataset.mode)));
  $view.querySelector("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), btn = e.target.querySelector("button[type=submit]"), err = document.getElementById("authErr");
    const email = String(f.get("email") || "").trim(), password = String(f.get("password") || "");
    err.hidden = true; btn.disabled = true;
    try {
      if (mode === "signup") {
        const nm = String(f.get("name") || "").trim();
        if (!nm) throw { response: { message: "Напишите имя и фамилию." } };
        await pb.collection("users").create({ name: nm, email, password, passwordConfirm: password, invite: inviteCode || "" });
      }
      await pb.collection("users").authWithPassword(email, password);
      if (inviteCode) history.replaceState(null, "", "/" + location.hash);
      await start();
    } catch (ex) { err.textContent = errText(ex); err.hidden = false; btn.disabled = false; }
  });
}

/* ---------- старт ---------- */
async function loadUsers() {
  const list = await pb.collection("users").getFullList({ sort: "name", fields: "id,name,role,created" });
  S.users = Object.fromEntries(list.map((u) => [u.id, u]));
  S.teacher = list.find((u) => u.role === "teacher") || null;
}
async function start() {
  try { await pb.collection("users").authRefresh(); } catch (_) { pb.authStore.clear(); return renderAuth(); }
  S.me = pb.authStore.record;
  await loadUsers();
  document.getElementById("tabbar").hidden = false;
  document.getElementById("peopleTab").hidden = !isTeacher();
  const me = document.getElementById("meBtn");
  me.hidden = false; me.textContent = initials(S.me.name);
  me.onclick = () => (location.hash = "#/me");
  subscribe();
  refreshDot();
  if (!location.hash || location.hash === "#/") location.hash = "#/chat"; else route();
  if (!isTeacher()) maybeShowNewMemo();
}
window.addEventListener("hashchange", () => { if (pb.authStore.isValid) route(); });

async function subscribe() {
  if (S.unsub) { try { await S.unsub(); } catch (_) {} }
  S.unsub = await pb.collection("messages").subscribe("*", (e) => {
    if (e.action !== "create") return;
    const m = e.record;
    if (S.thread && inThread(m, S.thread)) { appendMessage(m); markSeen(S.thread); }
    else refreshDot();
    if (m.system && !isTeacher()) maybeShowNewMemo();
  });
}

/* ---------- маршруты ---------- */
function route() {
  const [, page, id] = (location.hash || "#/chat").split("/");
  const q = new URLSearchParams((location.hash.split("?")[1]) || "");
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("on",
    a.dataset.tab === page || (a.dataset.tab === "chat" && (page === "dms")) || (a.dataset.tab === "lessons" && ["lesson", "edit"].includes(page)) || (a.dataset.tab === "people" && ["sub", "invite"].includes(page)) || (a.dataset.tab === "trainers" && page === "trainer")));
  $view.className = "view";
  S.thread = null;
  const clean = (x) => (x || "").split("?")[0];
  const pages = { trainers: viewTrainers, trainer: () => viewTrainer(clean(id)), chat: () => viewChat(clean(id)), dms: viewDms, lessons: viewLessons, lesson: () => viewLesson(clean(id), q.get("tab")),
    edit: () => viewEdit(clean(id)), people: viewPeople, sub: () => viewSub(clean(id)), invite: viewInvite, me: viewMe };
  (pages[page] || pages.chat)().catch((e) => { $view.innerHTML = `<div class="empty">${esc(errText(e))}</div>`; });
}

/* ---------- чат ---------- */
const threadKey = (t) => (t.peer ? "dm:" + t.peer : "group");
function inThread(m, t) {
  if (!t.peer) return !m.to;
  const me = S.me.id;
  return (m.author === me && m.to === t.peer) || (m.author === t.peer && m.to === me);
}
function markSeen(t) { localStorage.setItem("seen:" + S.me.id + ":" + threadKey(t), new Date().toISOString()); refreshDot(); }
async function refreshDot() {
  try {
    const seen = (k) => localStorage.getItem("seen:" + S.me.id + ":" + k) || "1970";
    const g = await pb.collection("messages").getList(1, 1, { filter: `to = '' && author != '${S.me.id}'`, sort: "-created", fields: "created" });
    const d = await pb.collection("messages").getList(1, 30, { filter: `to = '${S.me.id}'`, sort: "-created", fields: "created,author" });
    let unread = g.items[0] && parseDate(g.items[0].created) > new Date(seen("group"));
    for (const m of d.items) if (parseDate(m.created) > new Date(seen("dm:" + m.author))) unread = true;
    document.getElementById("chatDot").hidden = !unread;
  } catch (_) {}
}
function installBanner() {
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone || localStorage.getItem("installHidden")) return "";
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (ios) return `<div class="install" id="inst"><span>Установите приложение: «Поделиться» → «На экран „Домой“».</span><button class="icon-btn" data-hide-install aria-label="Скрыть">×</button></div>`;
  if (S.installEvt) return `<div class="install" id="inst"><span>Поставьте приложение на главный экран телефона.</span><span class="row"><button class="btn mus" data-install>Установить</button><button class="icon-btn" data-hide-install aria-label="Скрыть">×</button></span></div>`;
  return "";
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installEvt = e; });

async function viewChat(peer) {
  if (!isTeacher() && peer === "teacher") peer = S.teacher?.id || "";
  const t = { peer: peer || null };
  S.thread = t;
  $view.className = "view chatmode";
  const segGroup = !t.peer;
  const dmTarget = isTeacher() ? "#/dms" : "#/chat/teacher";
  $view.innerHTML = `
  <div class="chat">
    <div class="chat-head">
      <div class="tabs" style="margin:0">
        <a href="#/chat" class="${segGroup ? "on" : ""}">Общий чат</a>
        <a href="${dmTarget}" class="${segGroup ? "" : "on"}">${isTeacher() ? "Личные" : "Дмитрию лично"}</a>
      </div>
      ${t.peer && isTeacher() ? `<span class="who">${esc(name(t.peer))}</span>` : ""}
    </div>
    ${installBanner()}
    <div class="msgs" id="msgs"><div class="empty">Загрузка…</div></div>
    <div class="attach-list" id="att"></div>
    <form class="composer" id="composer">
      <label class="icon-btn" title="Фото" aria-label="Прикрепить фото">+<input type="file" accept="image/*" multiple hidden id="imgIn"></label>
      <textarea id="txt" rows="1" placeholder="${segGroup ? "Сообщение группе" : "Личное сообщение"}"></textarea>
      <button class="icon-btn send" type="submit" aria-label="Отправить">↑</button>
    </form>
  </div>`;
  const inst = $view.querySelector("#inst");
  if (inst) inst.addEventListener("click", async (e) => {
    if (e.target.closest("[data-hide-install]")) { localStorage.setItem("installHidden", "1"); inst.remove(); }
    if (e.target.closest("[data-install]") && S.installEvt) { S.installEvt.prompt(); S.installEvt = null; inst.remove(); }
  });
  if (t.peer && !S.users[t.peer]) { $view.querySelector("#msgs").innerHTML = `<div class="empty">Собеседник не найден.</div>`; return; }
  const me = S.me.id;
  const filter = t.peer ? `(author = '${me}' && to = '${t.peer}') || (author = '${t.peer}' && to = '${me}')` : `to = ''`;
  const res = await pb.collection("messages").getList(1, 150, { filter, sort: "-created" });
  const box = $view.querySelector("#msgs");
  box.innerHTML = "";
  S.lastDay = null;
  const items = res.items.reverse();
  if (!items.length) box.innerHTML = `<div class="empty" id="emptyMsg">${segGroup ? "Здесь пока тихо. Напишите группе первое сообщение." : "Напишите сюда то, что не для всей группы."}</div>`;
  items.forEach(appendMessage);
  box.scrollTop = box.scrollHeight;
  markSeen(t);

  const txt = $view.querySelector("#txt"), imgIn = $view.querySelector("#imgIn"), att = $view.querySelector("#att");
  let files = [];
  const grow = () => { txt.style.height = "auto"; txt.style.height = Math.min(txt.scrollHeight, 140) + "px"; };
  txt.addEventListener("input", grow);
  txt.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !/mobi/i.test(navigator.userAgent)) { e.preventDefault(); $view.querySelector("#composer").requestSubmit(); } });
  imgIn.addEventListener("change", () => {
    files = files.concat([...imgIn.files]).slice(0, 6); imgIn.value = "";
    att.innerHTML = files.map((f) => `<img src="${URL.createObjectURL(f)}" alt="">`).join("");
  });
  $view.querySelector("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = txt.value.trim();
    if (!text && !files.length) return;
    const fd = new FormData();
    fd.append("author", me); if (t.peer) fd.append("to", t.peer);
    const btn = e.target.querySelector(".send"); btn.disabled = true;
    fd.append("text", text); (await compressAll(files)).forEach((f) => fd.append("images", f));
    try { await pb.collection("messages").create(fd); txt.value = ""; files = []; att.innerHTML = ""; grow(); }
    catch (ex) { toast(errText(ex)); }
    btn.disabled = false; txt.focus();
  });
}
function appendMessage(m) {
  const box = document.getElementById("msgs");
  if (!box || box.querySelector(`[data-id="${m.id}"]`)) return;
  document.getElementById("emptyMsg")?.remove();
  const day = fmtDay(m.created);
  let html = "";
  if (day !== S.lastDay) { html += `<div class="day">${esc(day)}</div>`; S.lastDay = day; }
  if (m.system) {
    html += `<div class="announce" data-id="${m.id}"><b>Новая памятка</b>${esc(m.text)}
      ${m.lesson ? `<div><a class="btn dark" href="#/lesson/${m.lesson}">Открыть</a></div>` : ""}</div>`;
  } else {
    const mine = m.author === S.me.id, teacher = S.users[m.author]?.role === "teacher";
    const imgs = (m.images || []).map((f) => `<img src="${esc(fileUrl(m, f, "480x0"))}" data-full="${esc(fileUrl(m, f))}" alt="Фото" loading="lazy">`).join("");
    html += `<div class="msg ${mine ? "mine" : ""}" data-id="${m.id}">
      ${!mine && !S.thread?.peer ? `<div class="name ${teacher ? "teacher" : ""}">${esc(name(m.author))}</div>` : ""}
      ${imgs ? `<div class="imgs">${imgs}</div>` : ""}
      ${m.text ? `<div class="t">${linkify(m.text)}</div>` : ""}
      <div class="time">${fmtTime(m.created)}</div></div>`;
  }
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.insertAdjacentHTML("beforeend", html);
  if (near || m.author === S.me.id) box.scrollTop = box.scrollHeight;
}
async function viewDms() {
  const students = Object.values(S.users).filter((u) => u.role === "student");
  const recent = await pb.collection("messages").getList(1, 200, { filter: `to = '${S.me.id}' || (author = '${S.me.id}' && to != '')`, sort: "-created", fields: "author,to,text,created" });
  const last = {};
  for (const m of recent.items) { const p = m.author === S.me.id ? m.to : m.author; if (!last[p]) last[p] = m; }
  students.sort((a, b) => (last[b.id]?.created || "").localeCompare(last[a.id]?.created || "") || a.name.localeCompare(b.name));
  const seen = (id) => localStorage.getItem("seen:" + S.me.id + ":dm:" + id) || "1970";
  $view.innerHTML = `
  <div class="tabs" style="margin-top:0"><a href="#/chat">Общий чат</a><a href="#/dms" class="on">Личные</a></div>
  ${students.length ? `<div class="list">${students.map((u) => {
    const m = last[u.id]; const unread = m && m.author === u.id && parseDate(m.created) > new Date(seen(u.id));
    return `<a class="item" href="#/chat/${u.id}"><div class="body"><div class="title">${esc(u.name)}</div>
      <div class="meta">${m ? esc((m.author === S.me.id ? "Вы: " : "") + (m.text || "Фото")).slice(0, 80) : "Нет сообщений"}</div></div>
      <div class="side">${m ? `<span class="small muted">${fmtDay(m.created)}</span>` : ""}${unread ? `<span class="pill redo">новое</span>` : ""}</div></a>`;
  }).join("")}</div>` : `<div class="empty">Учеников пока нет. <a href="#/invite">Пригласите группу</a>.</div>`}`;
}

/* ---------- новая памятка: открывается сама ---------- */
async function maybeShowNewMemo() {
  try {
    const ls = await pb.collection("lessons").getList(1, 1, { sort: "-publish_at", fields: "id,number,title,memo,memo_file,publish_at,collectionId" });
    const l = ls.items[0]; if (!l) return;
    const v = await pb.collection("memo_views").getList(1, 1, { filter: `lesson = '${l.id}' && user = '${S.me.id}'` });
    if (v.items.length || !$overlay.hidden) return;
    openOverlay(`<div class="sheet" role="dialog" aria-label="Памятка">
      <div class="hero"><div class="no">Новая памятка · Занятие ${esc(l.number || "")}</div><h1>${esc(l.title)}</h1></div>
      <div class="prose">${md(l.memo) || "<p>Памятка прикреплена файлом.</p>"}</div>
      ${l.memo_file ? `<p><a class="btn" href="${esc(fileUrl(l, l.memo_file))}" target="_blank" rel="noopener">Скачать PDF</a></p>` : ""}
      <div class="row" style="margin-top:20px"><a class="btn dark" href="#/lesson/${l.id}?tab=hw" data-close>Открыть домашнее задание</a><button class="btn" data-close>Закрыть</button></div>
    </div>`);
    markMemoSeen(l.id);
  } catch (_) {}
}
async function markMemoSeen(lessonId) {
  if (isTeacher()) return;
  try { await pb.collection("memo_views").create({ lesson: lessonId, user: S.me.id }); } catch (_) {}
}

/* ---------- занятия ---------- */
async function viewLessons() {
  const lessons = await pb.collection("lessons").getFullList({ sort: "number,publish_at" });
  let subs = [];
  if (isTeacher()) subs = await pb.collection("submissions").getFullList({ fields: "lesson,status" });
  else subs = await pb.collection("submissions").getFullList({ filter: `student = '${S.me.id}'` });
  const studentsCount = Object.values(S.users).filter((u) => u.role === "student").length;
  const now = new Date();
  $view.innerHTML = `
  <div class="spread"><h1 style="margin:0">Занятия</h1>${isTeacher() ? `<a class="btn dark" href="#/edit/new">Новое занятие</a>` : ""}</div>
  <div style="height:16px"></div>
  ${lessons.length ? `<div class="list">${lessons.map((l) => {
    const future = parseDate(l.publish_at) > now;
    let side = "";
    if (isTeacher()) {
      const n = subs.filter((s) => s.lesson === l.id).length;
      side = future ? `<span class="pill soon">Выйдет ${esc(fmtDayTime(l.publish_at))}</span>` : `<span class="pill none">Сдали ${n} из ${studentsCount}</span>`;
    } else {
      const [cls, label] = statusOf(subs.find((s) => s.lesson === l.id), l);
      side = `<span class="pill ${cls}">${label}</span>`;
    }
    return `<a class="item" href="#/lesson/${l.id}"><div class="num">${esc(l.number ?? "")}</div>
      <div class="body"><div class="title">${esc(l.title)}</div>
      <div class="meta">${l.due_at ? "Сдать до " + esc(fmtDayTime(l.due_at)) : "Открыто " + esc(fmtDay(l.publish_at))}</div></div>
      <div class="side">${side}</div></a>`;
  }).join("")}</div>` : `<div class="empty">${isTeacher() ? "Добавьте первое занятие: памятку и домашнее задание." : "Памятки и домашки появятся здесь после занятий."}</div>`}`;
}

async function viewLesson(id, tab) {
  const l = await pb.collection("lessons").getOne(id);
  tab = tab || "memo";
  let sub = null;
  if (!isTeacher()) {
    const r = await pb.collection("submissions").getList(1, 1, { filter: `lesson = '${id}' && student = '${S.me.id}'` });
    sub = r.items[0] || null;
  }
  const future = parseDate(l.publish_at) > new Date();
  const tabs = [["memo", "Памятка"], ["hw", "Домашнее задание"]].concat(isTeacher() ? [] : [["work", "Моя работа"]]);
  $view.innerHTML = `
  <div class="hero">
    <div class="no">Занятие ${esc(l.number ?? "")}${future ? " · выйдет " + esc(fmtDayTime(l.publish_at)) : ""}</div>
    <h1>${esc(l.title)}</h1>
    ${isTeacher() ? `<div class="row"><a class="btn" href="#/edit/${l.id}">Редактировать</a><a class="btn" href="#/people">Кто сдал</a></div>` : ""}
  </div>
  <div class="tabs">${tabs.map(([k, v]) => `<a href="#/lesson/${l.id}?tab=${k}" class="${tab === k ? "on" : ""}">${v}</a>`).join("")}</div>
  <div id="pane"></div>`;
  const pane = $view.querySelector("#pane");
  if (tab === "memo") {
    pane.innerHTML = `${l.memo_file ? `<p><a class="btn mus" href="${esc(fileUrl(l, l.memo_file))}" target="_blank" rel="noopener">Скачать памятку PDF</a></p>` : ""}
      <div class="prose">${md(l.memo) || (l.memo_file ? "" : `<p class="muted">Памятки пока нет.</p>`)}</div>`;
    markMemoSeen(l.id);
  } else if (tab === "hw") {
    pane.innerHTML = `${l.due_at ? `<p><span class="pill submitted">Сдать до ${esc(fmtDayTime(l.due_at))}</span></p>` : ""}
      <div class="prose">${md(l.homework) || `<p class="muted">Домашнего задания нет.</p>`}</div>
      ${isTeacher() ? "" : `<p style="margin-top:24px"><a class="btn dark" href="#/lesson/${l.id}?tab=work">${sub ? "Моя работа" : "Сдать работу"}</a></p>`}`;
  } else if (tab === "work") {
    renderWork(pane, l, sub, false);
  }
}

function filesHtml(rec, field, removable) {
  return (rec?.[field] || []).map((f) => `<div class="f">${isImg(f)
    ? `<img src="${esc(fileUrl(rec, f, "480x0"))}" data-full="${esc(fileUrl(rec, f))}" alt="">`
    : `<a class="doc" href="${esc(fileUrl(rec, f))}" target="_blank" rel="noopener">${esc(f.replace(/_[a-z0-9]{10}(\.\w+)$/i, "$1"))}</a>`}
    ${removable ? `<button type="button" class="rm" data-rm="${esc(f)}" aria-label="Убрать файл">×</button>` : ""}</div>`).join("");
}
function renderWork(pane, l, sub, editing) {
  const [cls, label] = statusOf(sub, l);
  if (sub && !editing) {
    pane.innerHTML = `
      <div class="spread"><span class="pill ${cls}">${label}</span><span class="small muted">Обновлено ${esc(fmtDayTime(sub.updated))}</span></div>
      ${sub.feedback ? `<div class="feedback"><b>Комментарий ${esc(S.teacher?.name || "преподавателя")}</b><div style="white-space:pre-wrap">${linkify(sub.feedback)}</div></div>` : ""}
      ${sub.text ? `<div style="white-space:pre-wrap;margin:14px 0">${linkify(sub.text)}</div>` : ""}
      <div class="files">${filesHtml(sub, "files", false)}</div>
      <button class="btn dark" id="editWork">${sub.status === "redo" ? "Доработать и отправить" : "Изменить работу"}</button>`;
    pane.querySelector("#editWork").onclick = () => renderWork(pane, l, sub, true);
    return;
  }
  const removed = [];
  pane.innerHTML = `
    <form id="workForm">
      <label class="field"><span>Ответы на задания</span><textarea class="in" name="text" rows="8" placeholder="Паспорт камеры, мысли про фокусные, ссылки…">${esc(sub?.text || "")}</textarea></label>
      ${sub ? `<div class="files" id="oldFiles">${filesHtml(sub, "files", true)}</div>` : ""}
      <label class="btn" style="margin-bottom:10px">Добавить фото или файлы<input type="file" name="files" multiple hidden accept="image/*,application/pdf"></label>
      <div class="files" id="newFiles"></div>
      <div class="err" id="wErr" hidden></div>
      <div class="row" style="margin-top:12px"><button class="btn dark" type="submit">Отправить работу</button>${sub ? `<button class="btn" type="button" id="cancelW">Отмена</button>` : ""}</div>
    </form>`;
  const form = pane.querySelector("#workForm"); const fileIn = form.elements["files"], textIn = form.elements["text"];
  let added = [];
  fileIn.addEventListener("change", () => {
    added = added.concat([...fileIn.files]).slice(0, 15); fileIn.value = "";
    pane.querySelector("#newFiles").innerHTML = added.map((f) => f.type.startsWith("image/")
      ? `<div class="f"><img src="${URL.createObjectURL(f)}" alt=""></div>` : `<div class="f"><span class="doc">${esc(f.name)}</span></div>`).join("");
  });
  pane.querySelector("#oldFiles")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]"); if (!b) return;
    removed.push(b.dataset.rm); b.parentElement.remove();
  });
  pane.querySelector("#cancelW")?.addEventListener("click", () => renderWork(pane, l, sub, false));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = pane.querySelector("#wErr"), btn = form.querySelector("[type=submit]");
    const text = textIn.value.trim();
    if (!text && !added.length && !(sub && (sub.files || []).length > removed.length)) { err.textContent = "Добавьте текст или файлы."; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = "Отправляю…"; err.hidden = true;
    const ready = await compressAll(added);
    const fd = new FormData();
    fd.append("text", text);
    if (sub) { ready.forEach((f) => fd.append("files+", f)); removed.forEach((f) => fd.append("files-", f)); }
    else { fd.append("lesson", l.id); fd.append("student", S.me.id); ready.forEach((f) => fd.append("files", f)); }
    try {
      const saved = sub ? await pb.collection("submissions").update(sub.id, fd) : await pb.collection("submissions").create(fd);
      toast("Работа отправлена");
      renderWork(pane, l, saved, false);
    } catch (ex) { err.textContent = errText(ex); err.hidden = false; btn.disabled = false; btn.textContent = "Отправить работу"; }
  });
}

/* ---------- редактор занятия (преподаватель) ---------- */
async function viewEdit(id) {
  if (!isTeacher()) return (location.hash = "#/lessons");
  const isNew = id === "new";
  let l = { number: "", title: "", memo: "", homework: "", publish_at: "", due_at: "" };
  if (!isNew) l = await pb.collection("lessons").getOne(id);
  else {
    const all = await pb.collection("lessons").getFullList({ fields: "number", sort: "-number" });
    l.number = (all[0]?.number || 0) + 1;
  }
  $view.innerHTML = `
  <h1>${isNew ? "Новое занятие" : "Занятие " + esc(l.number)}</h1>
  <form id="ed">
    <div class="row" style="align-items:flex-start">
      <label class="field" style="flex:0 0 110px"><span>Номер</span><input class="in" name="number" type="number" min="0" value="${esc(l.number)}"></label>
      <label class="field" style="flex:1 1 240px"><span>Тема</span><input class="in" name="title" required value="${esc(l.title)}"></label>
    </div>
    <div class="row" style="align-items:flex-start">
      <label class="field" style="flex:1 1 220px"><span>Открыть ученикам</span><input class="in" name="publish_at" type="datetime-local" required value="${esc(isoToMsk(l.publish_at))}">
        <div class="hint">По Москве. В это время в чат придёт анонс, а памятка откроется у всех.</div></label>
      <label class="field" style="flex:1 1 220px"><span>Сдать домашку до</span><input class="in" name="due_at" type="datetime-local" value="${esc(isoToMsk(l.due_at))}"><div class="hint">По Москве</div></label>
    </div>
    <label class="field"><span>Памятка</span><textarea class="in tall" name="memo">${esc(l.memo)}</textarea>
      <div class="hint">Разметка: ## Заголовок, **жирный**, списки через «- », цитата через «> », таблицы.</div></label>
    <label class="field"><span>Памятка файлом (PDF)</span>
      ${l.memo_file ? `<div class="row small" style="margin-bottom:8px">Сейчас: <a href="${esc(fileUrl(l, l.memo_file))}" target="_blank" rel="noopener">${esc(l.memo_file)}</a><label class="small"><input type="checkbox" name="rmfile"> убрать</label></div>` : ""}
      <input type="file" name="memo_file" accept="application/pdf"></label>
    <label class="field"><span>Домашнее задание</span><textarea class="in tall" name="homework">${esc(l.homework)}</textarea></label>
    <div class="err" id="edErr" hidden></div>
    <div class="spread" style="margin-top:8px">
      <div class="row"><button class="btn dark" type="submit">Сохранить</button><a class="btn" href="${isNew ? "#/lessons" : "#/lesson/" + l.id}">Отмена</a></div>
      ${isNew ? "" : `<button type="button" class="btn quiet" id="del">Удалить занятие</button>`}
    </div>
  </form>`;
  const f = $view.querySelector("#ed"); const F = (n) => f.elements[n];
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $view.querySelector("#edErr"), btn = f.querySelector("[type=submit]");
    if (!F("title").value.trim() || !F("publish_at").value) { err.textContent = "Заполните тему и дату открытия."; err.hidden = false; return; }
    const fd = new FormData();
    fd.append("number", F("number").value || "0");
    fd.append("title", F("title").value.trim());
    fd.append("publish_at", mskToISO(F("publish_at").value));
    fd.append("due_at", mskToISO(F("due_at").value));
    fd.append("memo", F("memo").value);
    fd.append("homework", F("homework").value);
    if (F("memo_file").files[0]) fd.append("memo_file", F("memo_file").files[0]);
    else if (F("rmfile")?.checked) fd.append("memo_file", "");
    if (!isNew && parseDate(mskToISO(F("publish_at").value)) > new Date()) fd.append("announced", "false");
    btn.disabled = true;
    try {
      const saved = isNew ? await pb.collection("lessons").create(fd) : await pb.collection("lessons").update(l.id, fd);
      toast("Сохранено"); location.hash = "#/lesson/" + saved.id;
    } catch (ex) { err.textContent = errText(ex); err.hidden = false; btn.disabled = false; }
  });
  $view.querySelector("#del")?.addEventListener("click", async () => {
    if (!confirm("Удалить занятие вместе со сданными работами?")) return;
    try { await pb.collection("lessons").delete(l.id); toast("Удалено"); location.hash = "#/lessons"; } catch (ex) { toast(errText(ex)); }
  });
}

/* ---------- кто что сдал (преподаватель) ---------- */
async function viewPeople() {
  if (!isTeacher()) return (location.hash = "#/chat");
  await loadUsers();
  const [lessons, subs, views] = await Promise.all([
    pb.collection("lessons").getFullList({ sort: "number,publish_at", fields: "id,number,title,publish_at,due_at" }),
    pb.collection("submissions").getFullList({ fields: "id,lesson,student,status" }),
    pb.collection("memo_views").getFullList({ fields: "lesson,user" }),
  ]);
  const students = Object.values(S.users).filter((u) => u.role === "student").sort((a, b) => a.name.localeCompare(b.name));
  const open = lessons.filter((l) => parseDate(l.publish_at) <= new Date());
  const subOf = (l, u) => subs.find((s) => s.lesson === l && s.student === u);
  const seen = new Set(views.map((v) => v.lesson + ":" + v.user));
  const glyph = { submitted: "?", reviewed: "✓", redo: "↺", late: "!", none: "" };
  const toReview = subs.filter((s) => s.status === "submitted").length;
  $view.innerHTML = `
  <div class="spread"><h1 style="margin:0">Ученики</h1><a class="btn dark" href="#/invite">Пригласить</a></div>
  <p class="muted">${students.length} в группе${toReview ? ` · <b style="color:var(--ink)">${toReview} ${toReview === 1 ? "работа ждёт" : "работы ждут"} проверки</b>` : ""}</p>
  ${!students.length ? `<div class="empty">Пока никого. Отправьте группе ссылку-приглашение.</div>` :
    !open.length ? `<div class="empty">Таблица заполнится, когда откроется первое занятие.</div>` : `
  <div class="grid-wrap"><table class="mon">
    <thead><tr><th></th>${open.map((l) => `<th><a href="#/lesson/${l.id}" title="${esc(l.title)}">№${esc(l.number)}</a></th>`).join("")}</tr></thead>
    <tbody>
    <tr class="sum"><td>Сдали</td>${open.map((l) => `<td>${subs.filter((s) => s.lesson === l.id).length}/${students.length}</td>`).join("")}</tr>
    ${students.map((u) => `<tr><td><a href="#/chat/${u.id}" title="Написать лично">${esc(u.name)}</a></td>${open.map((l) => {
      const s = subOf(l.id, u.id); const [cls] = statusOf(s, l);
      const seenCls = seen.has(l.id + ":" + u.id) ? " seen" : "";
      return `<td>${s ? `<a class="cell ${cls}${seenCls}" href="#/sub/${s.id}" aria-label="${esc(u.name)}, занятие ${esc(l.number)}">${glyph[cls]}</a>` : `<span class="cell ${cls}${seenCls}">${glyph[cls]}</span>`}</td>`;
    }).join("")}</tr>`).join("")}
    </tbody></table></div>
  <div class="legend">
    <span><i class="cell submitted">?</i>ждёт проверки</span><span><i class="cell reviewed">✓</i>принято</span>
    <span><i class="cell redo">↺</i>на доработке</span><span><i class="cell late">!</i>срок прошёл</span>
    <span><i class="cell"></i>не сдано</span><span><i class="cell seen"></i>открыл памятку</span>
  </div>`}`;
}

async function viewSub(id) {
  if (!isTeacher()) return (location.hash = "#/lessons");
  const s = await pb.collection("submissions").getOne(id, { expand: "lesson" });
  const l = s.expand?.lesson || {};
  const [cls, label] = statusOf(s, l);
  $view.innerHTML = `
  <p><a href="#/people" class="small">← Ко всем ученикам</a></p>
  <h1>${esc(name(s.student))}</h1>
  <div class="spread"><span>Занятие ${esc(l.number ?? "")}: ${esc(l.title || "")}</span><span class="pill ${cls}">${label}</span></div>
  <p class="small muted">Сдано ${esc(fmtDayTime(s.created))}${s.updated !== s.created ? ", обновлено " + esc(fmtDayTime(s.updated)) : ""}</p>
  ${s.text ? `<div style="white-space:pre-wrap;margin:14px 0">${linkify(s.text)}</div>` : ""}
  <div class="files">${filesHtml(s, "files", false)}</div>
  <form id="rv" style="margin-top:20px">
    <label class="field"><span>Ваш комментарий</span><textarea class="in" name="feedback" rows="6" placeholder="Что получилось, что подтянуть, что попробовать дальше">${esc(s.feedback)}</textarea></label>
    <div class="row">
      <button class="btn dark" type="submit" data-st="reviewed">Принять работу</button>
      <button class="btn ter" type="submit" data-st="redo">Вернуть на доработку</button>
      <a class="btn" href="#/chat/${s.student}">Написать лично</a>
    </div>
  </form>`;
  $view.querySelector("#rv").addEventListener("submit", async (e) => {
    e.preventDefault();
    const st = e.submitter?.dataset.st || "reviewed";
    const fb = e.target.elements["feedback"].value.trim();
    try {
      await pb.collection("submissions").update(s.id, { status: st, feedback: fb });
      const txt = st === "reviewed" ? `Посмотрел вашу работу к занятию ${l.number ?? ""}: принято.` : `Посмотрел вашу работу к занятию ${l.number ?? ""}: нужно доработать.`;
      await pb.collection("messages").create({ author: S.me.id, to: s.student, text: txt + (fb ? " Комментарий — во вкладке «Моя работа»." : "") + `\n${location.origin}/#/lesson/${s.lesson}?tab=work` });
      toast(st === "reviewed" ? "Принято, ученик получил сообщение" : "Отправлено на доработку");
      location.hash = "#/people";
    } catch (ex) { toast(errText(ex)); }
  });
}

/* ---------- приглашение ---------- */
async function viewInvite() {
  if (!isTeacher()) return (location.hash = "#/chat");
  let inv = (await pb.collection("invites").getList(1, 1, { filter: "active = true", sort: "-created" })).items[0];
  const draw = () => {
    const link = inv ? `${location.origin}/?invite=${inv.code}` : "";
    const members = Object.values(S.users).sort((a, b) => a.name.localeCompare(b.name));
    $view.innerHTML = `
    <p><a href="#/people" class="small">← Ученики</a></p>
    <h1>Пригласить в группу</h1>
    <p>Отправьте эту ссылку ученикам в любой мессенджер. По ней они зарегистрируются и сразу попадут в группу.</p>
    ${inv ? `<div class="linkbox" id="lnk">${esc(link)}</div>
      <div class="row"><button class="btn dark" id="copy">Скопировать ссылку</button>${navigator.share ? `<button class="btn" id="share">Поделиться</button>` : ""}</div>` : `<p class="muted">Активной ссылки нет.</p>`}
    <h3>Ссылка попала не туда?</h3>
    <p class="muted small">Создайте новую — старая перестанет работать. Уже зарегистрированные останутся в группе.</p>
    <button class="btn" id="regen">Создать новую ссылку</button>
    <h3>В группе: ${members.length}</h3>
    <div class="list">${members.map((u) => `<div class="item"><div class="body"><div class="title">${esc(u.name)}</div><div class="meta">${u.role === "teacher" ? "Преподаватель" : "С " + esc(fmtDay(u.created))}</div></div></div>`).join("")}</div>`;
    $view.querySelector("#copy")?.addEventListener("click", async () => { try { await navigator.clipboard.writeText(link); toast("Ссылка скопирована"); } catch (_) { toast("Выделите и скопируйте ссылку вручную"); } });
    $view.querySelector("#share")?.addEventListener("click", () => navigator.share({ title: "Полное погружение", text: "Чат и домашки курса «Полное погружение»", url: link }).catch(() => {}));
    $view.querySelector("#regen").addEventListener("click", async () => {
      if (inv && !confirm("Старая ссылка перестанет работать. Продолжить?")) return;
      try {
        if (inv) await pb.collection("invites").update(inv.id, { active: false });
        const a = "abcdefghjkmnpqrstuvwxyz23456789"; let c = "";
        crypto.getRandomValues(new Uint32Array(10)).forEach((n) => (c += a[n % a.length]));
        inv = await pb.collection("invites").create({ code: c, active: true });
        draw(); toast("Новая ссылка готова");
      } catch (ex) { toast(errText(ex)); }
    });
  };
  draw();
}

/* ---------- тренажёры ---------- */
const TRAINERS = [
  { id: "focal", file: "/trainers/focal.html", tag: "Объективы", title: "Фокусное расстояние и перспектива", text: "Как фокусное и дистанция меняют лицо и фон. Бочка широкоугольника и подушка телевика." },
  { id: "dof", file: "/trainers/dof.html", tag: "Резкость", title: "ГРИП: глубина резкости", text: "Дистанция фокусировки, диафрагма и фокусное. Нажмите на кадр, чтобы навести фокус." },
  { id: "exposure", file: "/trainers/exposure.html", tag: "Экспозиция", title: "Выдержка, диафрагма, ISO", text: "Солнце, облачно, ночь. Режимы M, A, S, P, фонтан, смаз и правило 1/фокусное." }
];
async function viewTrainers() {
  $view.innerHTML = `<h1>Тренажёры</h1>
  <p class="muted" style="margin-top:-6px">Интерактивные модели к занятиям. Крутите настройки и смотрите, что происходит с кадром.</p>
  <div class="trainer-list">${TRAINERS.map((t) => `<a class="trainer-card" href="#/trainer/${t.id}">
    <span class="k">${esc(t.tag)}</span><h2>${esc(t.title)}</h2><p>${esc(t.text)}</p></a>`).join("")}</div>`;
}
async function viewTrainer(id) {
  const t = TRAINERS.find((x) => x.id === id);
  if (!t) return (location.hash = "#/trainers");
  $view.className = "view trainermode";
  $view.innerHTML = `<div class="trainer-bar"><a class="btn quiet" href="#/trainers" style="min-height:38px;padding:6px 14px">← Все</a><b>${esc(t.title)}</b>
    <a class="btn quiet" href="${t.file}" target="_blank" rel="noopener" style="margin-left:auto;min-height:38px;padding:6px 14px">Открыть отдельно</a></div>
    <iframe class="trainer-frame" src="${t.file}" title="${esc(t.title)}" allow="fullscreen" allowfullscreen></iframe>`;
}

/* ---------- профиль ---------- */
async function viewMe() {
  $view.innerHTML = `
  <h1>Профиль</h1>
  <form id="pf">
    <label class="field"><span>Имя и фамилия</span><input class="in" name="name" value="${esc(S.me.name)}"></label>
    <label class="field"><span>Email</span><input class="in" value="${esc(S.me.email)}" disabled></label>
    <button class="btn dark" type="submit">Сохранить</button>
  </form>
  <h3>Приложение на телефоне</h3>
  <p class="small">iPhone: в Safari нажмите «Поделиться» → «На экран „Домой“». Android: в Chrome меню ⋮ → «Добавить на главный экран».</p>
  <div style="margin-top:28px"><button class="btn" id="out">Выйти</button></div>`;
  $view.querySelector("#pf").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await pb.collection("users").update(S.me.id, { name: e.target.elements["name"].value.trim() }); S.me = pb.authStore.record; await loadUsers(); document.getElementById("meBtn").textContent = initials(S.me.name); toast("Сохранено"); }
    catch (ex) { toast(errText(ex)); }
  });
  $view.querySelector("#out").addEventListener("click", async () => {
    try { await pb.realtime.unsubscribe(); } catch (_) {}
    pb.authStore.clear(); location.hash = ""; renderAuth("login");
  });
}

/* ---------- запуск ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
document.addEventListener("visibilitychange", () => { if (!document.hidden && pb.authStore.isValid) refreshDot(); });
if (pb.authStore.isValid) start(); else renderAuth();
