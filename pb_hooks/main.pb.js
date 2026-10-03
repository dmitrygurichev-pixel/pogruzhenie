/// <reference path="../pb_data/types.d.ts" />
// Логика мессенджера курса «Полное погружение».
// Внимание: в хуках PocketBase каждый обработчик изолирован — общие функции не выносить наружу.

// Регистрация: первый пользователь становится преподавателем, остальные — только по коду приглашения.
onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) { return e.next(); }
  let teachers = 0;
  try { teachers = $app.countRecords("users", $dbx.hashExp({ role: "teacher" })); } catch (_) {}
  if (teachers === 0) {
    e.record.set("role", "teacher");
    return e.next();
  }
  const body = e.requestInfo().body || {};
  const code = String(body.invite || "").trim().toLowerCase();
  if (!code) { throw new BadRequestError("Нужна ссылка-приглашение от преподавателя."); }
  try {
    $app.findFirstRecordByFilter("invites", "code = {:c} && active = true", { c: code });
  } catch (_) {
    throw new BadRequestError("Ссылка-приглашение недействительна. Попросите у преподавателя новую.");
  }
  e.record.set("role", "student");
  e.next();
}, "users");

// Обычные сообщения не могут притворяться системными
onRecordCreateRequest((e) => {
  if (!e.hasSuperuserAuth()) { e.record.set("system", false); }
  e.next();
}, "messages");

// Сдача домашки: статус всегда «на проверке», отзыв пустой, только после публикации занятия
onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) { return e.next(); }
  const lesson = $app.findRecordById("lessons", e.record.get("lesson"));
  const nowStr = new Date().toISOString().replace("T", " ");
  if (lesson.getString("publish_at") > nowStr) {
    throw new BadRequestError("Это занятие ещё не открыто.");
  }
  e.record.set("status", "submitted");
  e.record.set("feedback", "");
  e.next();
}, "submissions");

// Ученик правит работу — она снова уходит на проверку
onRecordUpdateRequest((e) => {
  const auth = e.auth;
  if (auth && auth.get("role") === "student") {
    e.record.set("status", "submitted");
  }
  e.next();
}, "submissions");

// Раз в минуту: публикуем в общий чат анонс вышедших памяток и домашек
cronAdd("announce_lessons", "* * * * *", () => {
  let teacher;
  try {
    teacher = $app.findFirstRecordByFilter("users", "role = 'teacher'");
  } catch (_) { return; }
  const due = $app.findRecordsByFilter("lessons", "announced = false && publish_at <= @now", "publish_at", 20, 0);
  const col = $app.findCollectionByNameOrId("messages");
  for (const l of due) {
    let text = "Вышли памятка и домашнее задание";
    const num = l.getInt("number");
    text += num ? " к занятию " + num : "";
    text += ": " + l.getString("title") + ".";
    const m = new Record(col);
    m.set("author", teacher.id);
    m.set("text", text);
    m.set("lesson", l.id);
    m.set("system", true);
    $app.save(m);
    l.set("announced", true);
    $app.save(l);
  }
});
