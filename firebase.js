'use strict';
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Ключ сервисного аккаунта берём из FIREBASE_SERVICE_ACCOUNT (содержимое JSON — для GitHub Actions)
// или из файла (GOOGLE_APPLICATION_CREDENTIALS либо serviceAccount.json рядом со скриптом).
function init() {
  let key;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    key = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    const file = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || 'serviceAccount.json');
    if (!fs.existsSync(file)) {
      throw new Error('Не найден ключ сервисного аккаунта. Положите serviceAccount.json рядом со скриптом или задайте FIREBASE_SERVICE_ACCOUNT.');
    }
    key = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  admin.initializeApp({ credential: admin.credential.cert(key) });
  return { db: admin.firestore(), messaging: admin.messaging() };
}
module.exports = { init };
