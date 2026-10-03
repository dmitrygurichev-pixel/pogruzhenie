/// <reference path="../pb_data/types.d.ts" />
// Схема мессенджера курса «Полное погружение»
migrate((app) => {
  const T = "@request.auth.role = 'teacher'";
  const AUTH = "@request.auth.id != ''";

  // --- пользователи
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new SelectField({ name: "role", values: ["teacher", "student"], maxSelect: 1 }));
  users.listRule = AUTH;
  users.viewRule = AUTH;
  users.createRule = "";                      // регистрация открыта, код приглашения проверяет хук
  users.updateRule = "id = @request.auth.id && @request.body.role:isset = false";
  users.deleteRule = null;
  app.save(users);

  const autodate = [
    { type: "autodate", name: "created", onCreate: true, onUpdate: false },
    { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
  ];

  // --- приглашения
  const invites = new Collection({
    type: "base", name: "invites",
    listRule: T, viewRule: T, createRule: T, updateRule: T, deleteRule: T,
    fields: [
      { type: "text", name: "code", required: true, min: 6, max: 32 },
      { type: "bool", name: "active" },
      ...autodate,
    ],
    indexes: ["CREATE UNIQUE INDEX idx_invites_code ON invites (code)"],
  });
  app.save(invites);

  // --- занятия: памятка + домашка, видны ученикам после publish_at
  const lessons = new Collection({
    type: "base", name: "lessons",
    listRule: AUTH + " && (publish_at <= @now || " + T + ")",
    viewRule: AUTH + " && (publish_at <= @now || " + T + ")",
    createRule: T, updateRule: T, deleteRule: T,
    fields: [
      { type: "number", name: "number", onlyInt: true },
      { type: "text", name: "title", required: true, max: 200 },
      { type: "date", name: "publish_at", required: true },
      { type: "text", name: "memo", max: 200000 },
      { type: "file", name: "memo_file", maxSelect: 1, maxSize: 30 * 1024 * 1024, mimeTypes: ["application/pdf"] },
      { type: "text", name: "homework", max: 50000 },
      { type: "date", name: "due_at" },
      { type: "bool", name: "announced" },
      ...autodate,
    ],
  });
  app.save(lessons);

  // --- сообщения: to пустое = общий чат, иначе личное
  const usersId = users.id;
  const messages = new Collection({
    type: "base", name: "messages",
    listRule: AUTH + " && (to = '' || to = @request.auth.id || author = @request.auth.id)",
    viewRule: AUTH + " && (to = '' || to = @request.auth.id || author = @request.auth.id)",
    createRule: AUTH + " && @request.body.author = @request.auth.id && (@request.body.to = '' || @request.body.to:isset = false || " + T + " || @request.body.to.role = 'teacher')",
    updateRule: "author = @request.auth.id && @request.body.author:isset = false && @request.body.to:isset = false",
    deleteRule: "author = @request.auth.id || " + T,
    fields: [
      { type: "relation", name: "author", collectionId: usersId, required: true, maxSelect: 1, cascadeDelete: true },
      { type: "relation", name: "to", collectionId: usersId, maxSelect: 1, cascadeDelete: true },
      { type: "text", name: "text", max: 4000 },
      { type: "file", name: "images", maxSelect: 6, maxSize: 15 * 1024 * 1024, mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif"], thumbs: ["480x0"] },
      { type: "relation", name: "lesson", collectionId: lessons.id, maxSelect: 1, cascadeDelete: true },
      { type: "bool", name: "system" },
      ...autodate,
    ],
    indexes: ["CREATE INDEX idx_messages_created ON messages (created)"],
  });
  app.save(messages);

  // --- сданные домашки
  const submissions = new Collection({
    type: "base", name: "submissions",
    listRule: T + " || student = @request.auth.id",
    viewRule: T + " || student = @request.auth.id",
    createRule: "@request.auth.role = 'student' && @request.body.student = @request.auth.id",
    updateRule: T + " || (student = @request.auth.id && @request.body.student:isset = false && @request.body.lesson:isset = false && @request.body.feedback:isset = false)",
    deleteRule: T,
    fields: [
      { type: "relation", name: "lesson", collectionId: lessons.id, required: true, maxSelect: 1, cascadeDelete: true },
      { type: "relation", name: "student", collectionId: usersId, required: true, maxSelect: 1, cascadeDelete: true },
      { type: "text", name: "text", max: 20000 },
      { type: "file", name: "files", maxSelect: 15, maxSize: 30 * 1024 * 1024, thumbs: ["480x0"] },
      { type: "select", name: "status", values: ["submitted", "reviewed", "redo"], maxSelect: 1 },
      { type: "text", name: "feedback", max: 20000 },
      ...autodate,
    ],
    indexes: ["CREATE UNIQUE INDEX idx_sub_lesson_student ON submissions (lesson, student)"],
  });
  app.save(submissions);

  // --- кто открыл памятку
  const views = new Collection({
    type: "base", name: "memo_views",
    listRule: T + " || user = @request.auth.id",
    viewRule: T + " || user = @request.auth.id",
    createRule: AUTH + " && @request.body.user = @request.auth.id",
    updateRule: null, deleteRule: T,
    fields: [
      { type: "relation", name: "lesson", collectionId: lessons.id, required: true, maxSelect: 1, cascadeDelete: true },
      { type: "relation", name: "user", collectionId: usersId, required: true, maxSelect: 1, cascadeDelete: true },
      ...autodate,
    ],
    indexes: ["CREATE UNIQUE INDEX idx_views_lesson_user ON memo_views (lesson, user)"],
  });
  app.save(views);

  // первое приглашение
  const inv = new Record(invites);
  inv.set("code", $security.randomStringWithAlphabet(10, "abcdefghjkmnpqrstuvwxyz23456789"));
  inv.set("active", true);
  app.save(inv);
}, (app) => {
  for (const n of ["memo_views", "submissions", "messages", "lessons", "invites"]) {
    try { app.delete(app.findCollectionByNameOrId(n)); } catch (_) {}
  }
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("role");
  app.save(users);
});
