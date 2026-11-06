'use strict';
// Один проход: новые записи/заказы за последние часы + ежедневная рассылка (если пора). Для GitHub Actions / планировщика.
require('./env').load();
const core = require('./core');
const { init } = require('./firebase');

(async () => {
  if (!core.ADMIN_EMAILS.length) throw new Error('Не задана переменная ADMIN_EMAILS (email админов через запятую)');
  const deps = init();
  const hours = Number(process.env.LOOKBACK_HOURS) || 6;
  const now = new Date();

  const fresh = await core.catchUp(deps, now, hours);
  console.log('Новые записи/заказы:', JSON.stringify(fresh));

  if (core.dailyWindow(now)) {
    console.log('Ежедневная рассылка:', JSON.stringify(await core.runDaily(deps, now)));
  } else {
    console.log('Ежедневная рассылка: ещё/уже не время (окно 10:00–20:00 ' + core.TZ + ')');
  }
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e && e.message ? e.message : e); process.exit(1); });
