'use strict';
/* ИграЛаб — логика push-уведомлений.
   Всё, что нужно менять (админы, часовой пояс, тексты), находится в этом файле.
   Зависимости (db, messaging) передаются снаружи, поэтому логику можно проверить без Firebase (см. test.js). */

// Админы берутся из переменной окружения ADMIN_EMAILS (через запятую) — тот же список, что adminEmails в account.html.
// В код адреса не вписываем, чтобы они не попали в публичный репозиторий.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

// Ежедневная рассылка уходит не раньше DAILY_HOUR и не позже DAILY_END_HOUR (по времени TZ)
const DAILY_HOUR = 10;
const DAILY_END_HOUR = 20;

// Часовой пояс игр и время «сегодня». Даты игр админ вводит в своём часовом поясе.
const TZ = 'Europe/Moscow';

// Игры с такими статусами в напоминания не попадают
const SKIP_STATUSES = ['cancelled', 'canceled', 'deleted', 'inactive', 'archived'];

// true — записанным на игру пишем «Ждём тебя сегодня», остальным «Сегодня игра».
// false — всем одинаковое «Сегодня игра».
const PERSONALIZE_REMINDERS = true;

const DEAD_TOKEN_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
];

/* ---------------- время и часовые пояса ---------------- */
function partsInTZ(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const o = {};
  f.formatToParts(date).forEach((p) => { if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10); });
  return { y: o.year, m: o.month, d: o.day, hh: o.hour, mm: o.minute, ss: o.second };
}
function offsetMs(date, tz) {
  const p = partsInTZ(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(date.getTime() / 1000) * 1000;
}
function zonedMidnight(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const off1 = offsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = offsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}
const pad = (n) => String(n).padStart(2, '0');

// Границы «сегодня» в часовом поясе tz + ключи даты
function dayInfo(now, tz) {
  const p = partsInTZ(now, tz);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  const isLeap = (p.y % 4 === 0 && p.y % 100 !== 0) || p.y % 400 === 0;
  return {
    year: p.y,
    start: zonedMidnight(p.y, p.m, p.d, tz),
    end: zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz),
    ymd: p.y + '-' + pad(p.m) + '-' + pad(p.d),
    mmdd: pad(p.m) + '-' + pad(p.d),
    feb28NonLeap: p.m === 2 && p.d === 28 && !isLeap
  };
}
function timeText(date, tz) {
  const p = partsInTZ(date, tz);
  if (p.hh === 0 && p.mm === 0) return ''; // время не задано
  return pad(p.hh) + ':' + pad(p.mm);
}

/* ---------------- вспомогательное ---------------- */
const chunk = (arr, n) => { const r = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; };
const clip = (s, n) => { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const toDate = (v) => (v && typeof v.toDate === 'function') ? v.toDate() : (v instanceof Date ? v : (typeof v === 'number' ? new Date(v) : null));
const whoOf = (x) => clip(x.userName || x.name || (x.userEmail || x.email || '').split('@')[0] || 'Пользователь', 40);

/* ---------------- отправка ---------------- */
async function tokenDocs(db, emails) {
  const out = [];
  if (!emails) {
    (await db.collection('pushTokens').get()).forEach((d) => out.push(d));
  } else {
    for (const part of chunk(emails, 10)) {
      (await db.collection('pushTokens').where('email', 'in', part).get()).forEach((d) => out.push(d));
    }
  }
  return out;
}

// docs — документы pushTokens; payload — {title, body, url, tag}
async function sendToDocs(deps, docs, payload) {
  const { db, messaging } = deps;
  const byToken = new Map();
  docs.forEach((d) => { const t = (d.data() || {}).token || d.id; if (t) byToken.set(t, d); });
  const tokens = Array.from(byToken.keys());
  const stats = { sent: 0, failed: 0, removed: 0 };
  if (!tokens.length) return stats;

  const data = {
    title: clip(payload.title, 80),
    body: clip(payload.body, 240),
    url: payload.url || 'account.html',
    tag: payload.tag || ''
  };
  for (const part of chunk(tokens, 500)) {
    const res = await messaging.sendEachForMulticast({
      tokens: part, data, webpush: { headers: { TTL: '86400', Urgency: 'high' } }
    });
    res.responses.forEach((r, i) => {
      if (r.success) { stats.sent++; return; }
      stats.failed++;
      const code = r.error && r.error.code;
      if (DEAD_TOKEN_CODES.includes(code)) {
        const doc = byToken.get(part[i]);
        if (doc && doc.ref) { stats.removed++; doc.ref.delete().catch(() => {}); }
      }
    });
  }
  return stats;
}
const notifyAdmins = async (deps, payload) => {
  if (!ADMIN_EMAILS.length) throw new Error('Не задана переменная ADMIN_EMAILS (email админов через запятую)');
  return sendToDocs(deps, await tokenDocs(deps.db, ADMIN_EMAILS), payload);
};

/* ---------------- триггеры ---------------- */
async function onBookingCreated(deps, id, b) {
  b = b || {};
  if (b.status && b.status !== 'booked') return null;
  const people = Number(b.peopleCount) > 1 ? ' · ' + b.peopleCount + ' чел.' : '';
  const when = b.eventDate ? ', ' + clip(b.eventDate, 40) : '';
  return notifyAdmins(deps, {
    title: 'Новая запись на игру',
    body: whoOf(b) + ' → «' + clip(b.eventTitle || 'Мероприятие', 60) + '»' + when + people,
    url: 'account.html', tag: 'booking-' + id
  });
}

async function onOrderCreated(deps, id, o) {
  o = o || {};
  const price = (o.productPrice !== undefined && o.productPrice !== null && o.productPrice !== '') ? ' (' + o.productPrice + ')' : '';
  const pickup = o.pickupLocationName ? ' · ' + clip(o.pickupLocationName, 40) : '';
  return notifyAdmins(deps, {
    title: 'Новый заказ',
    body: whoOf(o) + ': ' + clip(o.productName || 'товар', 60) + price + pickup,
    url: 'account.html', tag: 'order-' + id
  });
}

/* ---------------- без Cloud Functions: защита от дублей и «догонялка» ---------------- */
const alreadyExists = (e) => !!e && (e.code === 6 || /already exists/i.test(String(e.message)));

// Уведомляет о документе ровно один раз: отметка pushLog/sent-<вид>-<id> создаётся до отправки
async function notifyOnce(deps, kind, id, data) {
  const ref = deps.db.collection('pushLog').doc('sent-' + kind + '-' + id);
  try {
    await ref.create({ at: new Date() });
  } catch (e) {
    if (alreadyExists(e)) return { skipped: true };
    throw e;
  }
  try {
    return kind === 'booking' ? await onBookingCreated(deps, id, data) : await onOrderCreated(deps, id, data);
  } catch (e) {
    await ref.delete().catch(() => {}); // отправка не удалась — разрешаем повторить
    throw e;
  }
}

// Находит записи и заказы за последние N часов и уведомляет о тех, о которых ещё не писали
async function catchUp(deps, now, hours) {
  const since = new Date((now || new Date()).getTime() - (hours || 24) * 36e5);
  const items = [];
  (await deps.db.collection('bookings').where('createdAtServer', '>', since).get()).forEach((d) => items.push(['booking', d.id, d.data()]));
  (await deps.db.collection('orders').where('createdAt', '>', since).get()).forEach((d) => items.push(['order', d.id, d.data()]));
  const out = { bookings: 0, orders: 0, checked: items.length };
  for (const [kind, id, data] of items) {
    const r = await notifyOnce(deps, kind, id, data);
    if (!r || !r.skipped) out[kind + 's']++;
  }
  return out;
}

// Можно ли сейчас делать ежедневную рассылку (не раньше 10:00 и не позже 20:00)
function dailyWindow(now) {
  const h = partsInTZ(now || new Date(), TZ).hh;
  return h >= DAILY_HOUR && h < DAILY_END_HOUR;
}

/* ---------------- ежедневная рассылка ---------------- */
async function birthdaysToday(deps, day) {
  const snap = await deps.db.collection('users').select('birthDate', 'name', 'email').get();
  const res = [];
  snap.forEach((d) => {
    const u = d.data() || {};
    const bd = String(u.birthDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) return;
    const md = bd.slice(5, 10);
    if (md === day.mmdd || (day.feb28NonLeap && md === '02-29')) {
      const age = day.year - parseInt(bd.slice(0, 4), 10);
      res.push({ name: whoOf(u), age: age > 0 && age < 120 ? age : null });
    }
  });
  return res;
}

async function eventsToday(deps, day) {
  const snap = await deps.db.collection('events').where('date', '>=', day.start).where('date', '<', day.end).get();
  const res = [];
  snap.forEach((d) => {
    const e = d.data() || {};
    if (SKIP_STATUSES.includes(String(e.status || '').toLowerCase())) return;
    const dt = toDate(e.date);
    if (!dt) return;
    res.push({ id: d.id, title: clip(e.title || 'Игра', 60), venue: clip(e.venue || '', 40), at: dt, time: timeText(dt, TZ) });
  });
  res.sort((a, b) => a.at - b.at);
  return res;
}

const eventLine = (e) => '«' + e.title + '»' + (e.time ? ' в ' + e.time : '') + (e.venue ? ', ' + e.venue : '');
const eventsText = (list) => list.slice(0, 3).map(eventLine).join('; ') + (list.length > 3 ? ' и ещё ' + (list.length - 3) : '');

async function bookedByEmail(deps, events) {
  const map = new Map(); // email -> Set(eventId)
  const ids = events.map((e) => e.id);
  for (const part of chunk(ids, 10)) {
    (await deps.db.collection('bookings').where('eventId', 'in', part).get()).forEach((d) => {
      const b = d.data() || {};
      if (b.status !== 'booked') return;
      const em = String(b.email || '').trim().toLowerCase();
      if (!em) return;
      if (!map.has(em)) map.set(em, new Set());
      map.get(em).add(String(b.eventId));
    });
  }
  return map;
}

async function runDaily(deps, now) {
  const day = dayInfo(now || new Date(), TZ);
  const log = deps.db.collection('pushLog').doc('daily-' + day.ymd);
  try {
    await log.create({ startedAt: new Date(), ymd: day.ymd }); // защита от повторной рассылки за день
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) return { skipped: 'already-sent', ymd: day.ymd };
    throw e;
  }
  try {
    const report = { ymd: day.ymd };

    // 1) дни рождения -> админам
    const bdays = await birthdaysToday(deps, day);
    report.birthdays = bdays.length;
    if (bdays.length) {
      const names = bdays.slice(0, 10).map((x) => x.name + (x.age ? ' (' + x.age + ')' : '')).join(', ');
      await notifyAdmins(deps, {
        title: '🎂 Сегодня день рождения',
        body: names + (bdays.length > 10 ? ' и ещё ' + (bdays.length - 10) : ''),
        url: 'account.html', tag: 'birthdays-' + day.ymd
      });
    }

    // 2) игра сегодня -> всем
    const events = await eventsToday(deps, day);
    report.events = events.length;
    if (events.length) {
      const docs = await tokenDocs(deps.db, null);
      const booked = PERSONALIZE_REMINDERS ? await bookedByEmail(deps, events) : new Map();
      const groups = new Map(); // ключ (список игр, на которые записан) -> документы
      docs.forEach((d) => {
        const em = String((d.data() || {}).email || '').toLowerCase();
        const set = booked.get(em);
        const key = set && set.size ? Array.from(set).sort().join(',') : '*';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
      });
      report.tokens = docs.length;
      for (const [key, list] of groups) {
        let payload;
        if (key === '*') {
          payload = { title: 'Сегодня игра!', body: eventsText(events) + '. Приходи — будем рады!' };
        } else {
          const mine = events.filter((e) => key.split(',').includes(String(e.id)));
          payload = { title: 'Ждём тебя сегодня!', body: eventsText(mine) + '. До встречи!' };
        }
        payload.url = 'account.html';
        payload.tag = 'game-' + day.ymd;
        await sendToDocs(deps, list, payload);
      }
    }
    await log.set({ finishedAt: new Date(), report }, { merge: true });
    return report;
  } catch (e) {
    await log.delete().catch(() => {}); // даём шанс повторить
    throw e;
  }
}

module.exports = {
  ADMIN_EMAILS, TZ, dayInfo, timeText, partsInTZ, chunk,
  onBookingCreated, onOrderCreated, notifyOnce, catchUp, dailyWindow, runDaily, sendToDocs
};
