import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../dist');
const port = Number(process.env.LIFE_PORT || 4173);
http.createServer(async (request, response) => {
  const target = new URL(request.url, 'http://localhost').pathname;
  if (target.includes('..')) { response.writeHead(400); response.end(); return; }
  const filename = target === '/' ? 'index.html' : target.slice(1);
  try { const body = await fs.readFile(path.join(root, filename)); response.writeHead(200, { 'Content-Type': filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8' }); response.end(body); }
  catch { response.writeHead(404); response.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Life dashboard: http://127.0.0.1:${port}`));
