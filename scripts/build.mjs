// Builds the deployable site into _site/: copies the static files, renders one PNG per board
// with headless Chrome and writes build.json. If image rendering fails, the site still deploys.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as S from '../assets/stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(ROOT, 'data/db.json');
const COPY = ['index.html', 'card.html', 'robots.txt', 'assets'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain',
};

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, 'out'), { recursive: true });
await fs.mkdir(path.join(OUT, 'data'), { recursive: true });
for (const item of COPY) await fs.cp(path.join(ROOT, item), path.join(OUT, item), { recursive: true });
await fs.copyFile(DB_PATH, path.join(OUT, 'data/db.json'));

const db = JSON.parse(await fs.readFile(DB_PATH, 'utf8'));
const today = process.env.TODAY || S.todayISO();
const scopes = S.scopeList(db, today).filter(s => S.gamesFor(db, s).length > 0);
const images = await renderImages(scopes).catch(err => {
  console.error('::warning::Görseller üretilemedi:', err.message);
  return [];
});

const build = {
  sha: process.env.GITHUB_SHA || 'local',
  dataSha: gitBlobSha(DB_PATH),
  builtAt: new Date().toISOString(),
  images,
};
await fs.writeFile(path.join(OUT, 'build.json'), JSON.stringify(build, null, 2) + '\n');
console.log(`Hazır: ${images.length}/${scopes.length} görsel, veri ${build.dataSha.slice(0, 7)}`);

function gitBlobSha(file) {
  try {
    return execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function renderImages(list) {
  if (!list.length) return [];
  const executablePath = process.env.CHROME_PATH;
  if (!executablePath) throw new Error('CHROME_PATH tanımlı değil');
  const { default: puppeteer } = await import('puppeteer-core');

  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(OUT, rel || 'index.html');
    if (!file.startsWith(OUT)) { res.writeHead(403).end(); return; }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox', '--font-render-hinting=none'] });
  const done = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
    for (const scope of list) {
      try {
        await page.goto(`http://127.0.0.1:${port}/card.html?s=${scope.id}&today=${today}`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(id => window.__cardReady === true && window.__cardId === id, { timeout: 20000 }, scope.id);
        await page.screenshot({ path: path.join(OUT, 'out', `${scope.id}.png`), clip: { x: 0, y: 0, width: 1080, height: 1350 } });
        done.push(scope.id);
      } catch (err) {
        console.error(`::warning::${scope.label} görseli üretilemedi: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  return done;
}
