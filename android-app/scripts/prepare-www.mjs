// Копирует веб-приложение (../index.html и ../lib) в www/ — оттуда Capacitor берёт файлы для APK.
// Секрет приложения Яндекса (для входа по коду на ТВ) берётся из переменной окружения YANDEX_CLIENT_SECRET
// (в GitHub Actions — секрет репозитория) и попадает только в сборку APK, не в репозиторий и не в веб-версию.
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
cpSync(join(root, '..', 'index.html'), join(www, 'index.html'));
cpSync(join(root, '..', 'lib'), join(www, 'lib'), { recursive: true });
const cfg = { yaSecret: process.env.YANDEX_CLIENT_SECRET || '' };
writeFileSync(join(www, 'lib', 'app-config.js'), 'window.APP_CONFIG = ' + JSON.stringify(cfg) + ';\n');
console.log('www/ готов' + (cfg.yaSecret ? ' (секрет Яндекса добавлен)' : ' (без секрета Яндекса — вход по коду будет недоступен)'));
