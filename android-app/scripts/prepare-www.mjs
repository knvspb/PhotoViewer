// Копирует веб-приложение (../index.html и ../lib) в www/ — оттуда Capacitor берёт файлы для APK
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
cpSync(join(root, '..', 'index.html'), join(www, 'index.html'));
cpSync(join(root, '..', 'lib'), join(www, 'lib'), { recursive: true });
console.log('www/ готов');
