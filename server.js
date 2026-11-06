'use strict';
// Постоянно работающий вариант (VPS / компьютер): уведомления о записях и заказах приходят сразу.
require('./env').load();
const core = require('./core');
const { init } = require('./firebase');

if (!core.ADMIN_EMAILS.length) { console.error('Не задана переменная ADMIN_EMAILS (email админов через запятую)'); process.exit(1); }
const deps = init();
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS) || 24; // что «догоняем» после перезапуска
const stamp = () => new Date().toISOString();

// 1) Новые записи и заказы — по подписке в реальном времени
const since = new Date(Date.now() - LOOKBACK_HOURS * 36e5);
function watch(collection, field, kind) {
  deps.db.collection(collection).where(field, '>', since).onSnapshot(
    (snap) => snap.docChanges().forEach((ch) => {
      if (ch.type !== 'added') return;
      core.notifyOnce(deps, kind, ch.doc.id, ch.doc.data())
        .then((r) => { if (!r || !r.skipped) console.log(stamp(), 'отправлено:', kind, ch.doc.id); })
        .catch((e) => console.error(stamp(), 'ошибка отправки', kind, ch.doc.id, e && e.message));
    }),
    (err) => { console.error(stamp(), 'потеряна подписка на ' + collection + ':', err && err.message); process.exit(1); } // перезапустит pm2/systemd
  );
}
watch('bookings', 'createdAtServer', 'booking');
watch('orders', 'createdAt', 'order');

// 2) Ежедневная рассылка: проверяем раз в минуту, делаем один раз в сутки
let doneYmd = null, failYmd = null, fails = 0;
async function tickDaily() {
  const now = new Date();
  const ymd = core.dayInfo(now, core.TZ).ymd;
  if (doneYmd === ymd || !core.dailyWindow(now)) return;
  if (failYmd === ymd && fails >= 3) return;
  try {
    const r = await core.runDaily(deps, now);
    doneYmd = ymd;
    console.log(stamp(), 'ежедневная рассылка:', JSON.stringify(r));
  } catch (e) {
    if (failYmd !== ymd) { failYmd = ymd; fails = 0; }
    fails++;
    console.error(stamp(), 'ошибка ежедневной рассылки (' + fails + '/3):', e && e.message);
  }
}
setInterval(tickDaily, 60 * 1000);
tickDaily();
console.log(stamp(), 'ИграЛаб notifier запущен. Админов:', core.ADMIN_EMAILS.length, '| часовой пояс:', core.TZ);
