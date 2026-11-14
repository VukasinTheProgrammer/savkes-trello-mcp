import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchBoardHealth } from './tools/board-health.mjs';
import { summarizeBoard } from './board-health.mjs';

const host = '127.0.0.1'; // Loopback only: not publicly accessible or shared with teammates.
const port = Number(process.env.BOARD_DASHBOARD_PORT || 8790);
const htmlPath = fileURLToPath(new URL('../dashboard/index.html', import.meta.url));
const json = (res, code, payload) => {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(payload));
};
export function createDashboardServer({ analyze = fetchBoardHealth, page = () => readFile(htmlPath) } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${port}`);
      if (req.method !== 'GET') return json(res,405,{error:'Method not allowed'});
      if (url.pathname === '/') {
        const content = await page();
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'"});
        return res.end(content);
      }
      if (url.pathname === '/api/health' || url.pathname === '/api/summary') {
        // Never accept a board ID from an untrusted browser; use the configured board.
        const analysis = await analyze({includeHistory:false});
        return json(res,200,url.pathname === '/api/summary' ? summarizeBoard(analysis) : analysis);
      }
      return json(res,404,{error:'Not found'});
    } catch (err) {
      // Do not reflect Trello errors, which could contain credentials, into the browser.
      console.error('Dashboard request failed:', err?.name || 'Error');
      return json(res,502,{error:'Unable to load board metrics. Check Trello environment configuration and network access.'});
    }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  createDashboardServer().listen(port,host,()=>console.log(`Read-only Board Health dashboard: http://${host}:${port}/`));
}
