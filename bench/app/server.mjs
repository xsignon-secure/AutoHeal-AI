// The benchmark app: one page per case, read from pages.json next to this file
// ({ "<case id>": "<body html>" }). A UI change is a new pages.json.
import { readFileSync } from 'node:fs';
import http from 'node:http';

const port = Number(process.env.PORT ?? 4330);
const pages = JSON.parse(readFileSync(new URL('./pages.json', import.meta.url), 'utf8'));
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<p role="status" id="status"></p></body></html>`;

http
  .createServer((req, res) => {
    const id = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/c\//, '');
    const body = req.url === '/' ? '<h1>Bench</h1>' : pages[id];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(id, body ?? '<h1>Not found</h1>'));
  })
  .listen(port, '127.0.0.1');
