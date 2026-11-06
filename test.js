'use strict';
// Проверка логики без Firebase: node test.js
const assert = require('assert');
process.env.ADMIN_EMAILS = 'rangerg47@gmail.com, FEARTNS@mail.ru'; // как в GitHub Secret / .env
const core = require('./core');

/* ---- заглушка Firestore ---- */
function makeDb(seed) {
  const cols = {};
  Object.keys(seed).forEach((c) => { cols[c] = new Map(Object.entries(seed[c])); });
  const colOf = (n) => (cols[n] = cols[n] || new Map());
  const cmp = (a, b) => (a instanceof Date ? a.getTime() : a);
  const ops = {
    '==': (a, b) => a === b, in: (a, b) => b.includes(a),
    '>=': (a, b) => cmp(a) >= cmp(b), '<': (a, b) => cmp(a) < cmp(b), '>': (a, b) => cmp(a) > cmp(b)
  };
  function query(name, filters) {
    return {
      where: (f, op, v) => query(name, filters.concat([[f, op, v]])),
      select: () => query(name, filters),
      get: async () => {
        const docs = [];
        for (const [id, data] of colOf(name)) {
          if (filters.every(([f, op, v]) => data[f] !== undefined && ops[op](data[f], v))) {
            docs.push({ id, data: () => data, ref: { delete: async () => { colOf(name).delete(id); } } });
          }
        }
        return { forEach: (fn) => docs.forEach(fn), size: docs.length };
      },
      doc: (id) => ({
        create: async (d) => { if (colOf(name).has(id)) { const e = new Error('already exists'); e.code = 6; throw e; } colOf(name).set(id, d); },
        set: async (d, o) => { colOf(name).set(id, o && o.merge ? Object.assign({}, colOf(name).get(id), d) : d); },
        delete: async () => { colOf(name).delete(id); }
      })
    };
  }
  return { collection: (n) => query(n, []), _cols: cols };
}
/* ---- заглушка FCM ---- */
function makeMessaging(deadTokens) {
  const sent = [];
  return {
    sent,
    sendEachForMulticast: async (m) => {
      sent.push(m);
      return { responses: m.tokens.map((t) => deadTokens.includes(t)
        ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true }) };
    }
  };
}
const tok = (token, email) => [token, { token, email, uid: 'u-' + token }];

(async () => {
  /* 1. границы дня */
  const d = core.dayInfo(new Date('2026-11-06T07:00:00Z'), 'Europe/Moscow');
  assert.strictEqual(d.start.toISOString(), '2026-11-05T21:00:00.000Z');
  assert.strictEqual(d.end.toISOString(), '2026-11-06T21:00:00.000Z');
  assert.strictEqual(d.mmdd, '11-06');
  const ny = core.dayInfo(new Date('2026-03-08T18:00:00Z'), 'America/New_York'); // сутки перевода часов = 23 ч
  assert.strictEqual((ny.end - ny.start) / 36e5, 23);
  assert.strictEqual(core.timeText(new Date('2026-11-06T16:00:00Z'), 'Europe/Moscow'), '19:00');
  assert.strictEqual(core.timeText(new Date('2026-11-05T21:00:00Z'), 'Europe/Moscow'), ''); // полночь = время не задано
  console.log('ok  границы дня и время');

  /* 2. данные */
  const NOW = new Date('2026-11-06T07:00:00Z'); // 10:00 МСК
  const seed = {
    users: {
      a: { name: 'Ольга', email: 'o@x.ru', birthDate: '1999-11-06' },
      b: { name: 'Иван', email: 'i@x.ru', birthDate: '1990-11-06' },
      c: { name: 'Пётр', email: 'p@x.ru', birthDate: '1990-11-07' },
      d: { name: 'Без даты', email: 'n@x.ru' },
      e: { name: 'Плохая', email: 'z@x.ru', birthDate: '06.11.1990' }
    },
    events: {
      e1: { title: 'Мафия', venue: 'Бар «Ночь»', status: 'active', date: new Date('2026-11-06T16:00:00Z') },
      e2: { title: 'Завтра', status: 'active', date: new Date('2026-11-07T16:00:00Z') },
      e3: { title: 'Отменена', status: 'cancelled', date: new Date('2026-11-06T17:00:00Z') }
    },
    bookings: {
      b1: { eventId: 'e1', email: 'O@X.ru', status: 'booked' },
      b2: { eventId: 'e1', email: 'i@x.ru', status: 'cancelled' }
    },
    pushTokens: Object.fromEntries([
      tok('t-admin', 'rangerg47@gmail.com'), tok('t-admin2', 'feartns@mail.ru'),
      tok('t-olga', 'o@x.ru'), tok('t-ivan', 'i@x.ru'), tok('t-dead', 'p@x.ru'), tok('t-noemail', '')
    ])
  };
  const db = makeDb(seed);
  const messaging = makeMessaging(['t-dead']);
  const deps = { db, messaging };

  /* 3. ежедневная рассылка */
  const rep = await core.runDaily(deps, NOW);
  assert.strictEqual(rep.birthdays, 2);
  assert.strictEqual(rep.events, 1);
  const byTitle = (t) => messaging.sent.filter((m) => m.data.title === t);

  const bd = byTitle('🎂 Сегодня день рождения');
  assert.strictEqual(bd.length, 1);
  assert.deepStrictEqual(bd[0].tokens.sort(), ['t-admin', 't-admin2']);
  assert.ok(/Ольга \(27\)/.test(bd[0].data.body) && /Иван \(36\)/.test(bd[0].data.body), bd[0].data.body);
  assert.ok(!/Пётр/.test(bd[0].data.body));
  console.log('ok  дни рождения -> только админам:', bd[0].data.body);

  const wait = byTitle('Ждём тебя сегодня!');
  assert.strictEqual(wait.length, 1);
  assert.deepStrictEqual(wait[0].tokens, ['t-olga']);          // записана (email в другом регистре)
  assert.ok(/«Мафия» в 19:00, Бар «Ночь»/.test(wait[0].data.body), wait[0].data.body);
  const all = byTitle('Сегодня игра!');
  assert.strictEqual(all.length, 1);
  assert.deepStrictEqual(all[0].tokens.sort(), ['t-admin', 't-admin2', 't-dead', 't-ivan', 't-noemail']); // у Ивана запись отменена
  assert.ok(!/Завтра|Отменена/.test(all[0].data.body + wait[0].data.body));
  assert.ok(Object.values(all[0].data).every((v) => typeof v === 'string'));
  console.log('ok  «сегодня игра» -> всем; записанным — «ждём тебя»:', all[0].data.body);

  assert.ok(!db._cols.pushTokens.has('t-dead'), 'мёртвый токен должен удаляться');
  console.log('ok  мёртвый токен удалён');

  /* 4. повторный запуск в тот же день */
  const before = messaging.sent.length;
  const again = await core.runDaily(deps, NOW);
  assert.strictEqual(again.skipped, 'already-sent');
  assert.strictEqual(messaging.sent.length, before);
  console.log('ok  повторная рассылка за день заблокирована');

  /* 5. день без игр и без именинников — ничего не шлём */
  const quiet = await core.runDaily(deps, new Date('2026-11-10T07:00:00Z'));
  assert.strictEqual(messaging.sent.length, before);
  assert.deepStrictEqual([quiet.birthdays, quiet.events], [0, 0]);
  console.log('ok  пустой день — без уведомлений');

  /* 6. запись и заказ -> админам */
  const m2 = makeMessaging([]);
  await core.onBookingCreated({ db, messaging: m2 }, 'bk1',
    { name: 'Ольга', email: 'o@x.ru', eventTitle: 'Мафия', eventDate: '06.11.2026, 19:00', peopleCount: 3, status: 'booked' });
  assert.strictEqual(m2.sent.length, 1);
  assert.deepStrictEqual(m2.sent[0].tokens.sort(), ['t-admin', 't-admin2']);
  assert.strictEqual(m2.sent[0].data.title, 'Новая запись на игру');
  assert.ok(/Ольга → «Мафия», 06.11.2026, 19:00 · 3 чел\./.test(m2.sent[0].data.body), m2.sent[0].data.body);
  await core.onBookingCreated({ db, messaging: m2 }, 'bk2', { name: 'X', status: 'cancelled' });
  assert.strictEqual(m2.sent.length, 1);
  await core.onOrderCreated({ db, messaging: m2 }, 'o1',
    { userName: 'Иван', productName: 'Футболка', productPrice: 150, pickupLocationName: 'Бар «Ночь»' });
  assert.ok(/Иван: Футболка \(150\) · Бар «Ночь»/.test(m2.sent[1].data.body), m2.sent[1].data.body);
  console.log('ok  запись и заказ -> админам:', m2.sent[0].data.body, '|', m2.sent[1].data.body);


  /* 7. без Cloud Functions: догонялка и защита от дублей */
  assert.deepStrictEqual(core.ADMIN_EMAILS, ['rangerg47@gmail.com', 'feartns@mail.ru']);
  const NOW2 = new Date('2026-11-06T12:00:00Z');
  const hoursAgo = (h) => new Date(NOW2.getTime() - h * 36e5);
  const db2 = makeDb({
    bookings: {
      n1: { name: 'Ольга', email: 'o@x.ru', eventTitle: 'Мафия', status: 'booked', createdAtServer: hoursAgo(1) },
      n2: { name: 'Старая', eventTitle: 'Мафия', status: 'booked', createdAtServer: hoursAgo(30) },
      n3: { name: 'Отмена', eventTitle: 'Мафия', status: 'cancelled', createdAtServer: hoursAgo(2) }
    },
    orders: { o1: { userName: 'Иван', productName: 'Футболка', productPrice: 150, createdAt: hoursAgo(3) } },
    pushTokens: Object.fromEntries([tok('t-admin', 'rangerg47@gmail.com'), tok('t-user', 'o@x.ru')])
  });
  const m3 = makeMessaging([]);
  const r1 = await core.catchUp({ db: db2, messaging: m3 }, NOW2, 6);
  assert.deepStrictEqual([r1.bookings, r1.orders], [2, 1]);            // n1 и n3 (отметка ставится), заказ o1; «старая» не берётся
  assert.strictEqual(m3.sent.length, 2);                                // n3 отменена — уведомления нет
  assert.ok(m3.sent.every((m) => m.tokens.length === 1 && m.tokens[0] === 't-admin'));   // только админу, не пользователю
  const r2 = await core.catchUp({ db: db2, messaging: m3 }, NOW2, 6);  // повторный проход — тишина
  assert.deepStrictEqual([r2.bookings, r2.orders], [0, 0]);
  assert.strictEqual(m3.sent.length, 2);
  console.log('ok  догонялка: берёт новое за N часов, дубли не шлёт, пользователям админские не уходят');

  /* перезапуск «после простоя»: новые документы уходят, старые отметки не трогаются */
  db2._cols.bookings.set('n4', { name: 'Новая', eventTitle: 'Мафия', status: 'booked', createdAtServer: hoursAgo(0.1) });
  const r3 = await core.catchUp({ db: db2, messaging: m3 }, NOW2, 6);
  assert.strictEqual(r3.bookings, 1); assert.strictEqual(m3.sent.length, 3);
  console.log('ok  после перезапуска уходит только действительно новое');

  /* сбой отправки снимает отметку, чтобы повторить */
  const bad = { sendEachForMulticast: async () => { throw new Error('fcm down'); } };
  await assert.rejects(core.notifyOnce({ db: db2, messaging: bad }, 'order', 'o9', { userName: 'Х', productName: 'Y' }), /fcm down/);
  assert.ok(!db2._cols.pushLog.has('sent-order-o9'));
  console.log('ok  при сбое FCM отметка снимается — будет повтор');

  /* окно ежедневной рассылки */
  const w = (iso) => core.dailyWindow(new Date(iso));
  assert.deepStrictEqual([w('2026-11-06T06:59:00Z'), w('2026-11-06T07:00:00Z'), w('2026-11-06T16:59:00Z'), w('2026-11-06T17:00:00Z')],
                         [false, true, true, false]);      // 09:59 нет, 10:00 да, 19:59 да, 20:00 нет (МСК)
  console.log('ok  окно ежедневной рассылки 10:00–20:00 МСК');

  /* без списка админов — понятная ошибка, а не тишина */
  const saved = core.ADMIN_EMAILS.splice(0);
  await assert.rejects(core.onOrderCreated({ db: db2, messaging: m3 }, 'x', { productName: 'Y' }), /ADMIN_EMAILS/);
  core.ADMIN_EMAILS.push(...saved);
  console.log('ok  пустой ADMIN_EMAILS -> явная ошибка');

  console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
})().catch((e) => { console.error('ПРОВАЛ:', e); process.exit(1); });
