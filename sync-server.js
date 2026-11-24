/**
 * Lightweight sync trigger server
 * POST /api/sync - triggers sync-all.js
 * Auth: Bearer token in Authorization header
 */

import express from 'express';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';

const app = express();
const PORT = 3001;

// Read auth token from .env
const envContent = readFileSync('.env', 'utf8');
const validToken = envContent.split('\n')
  .find(l => l.startsWith('SYNC_TOKEN='))
  ?.split('=')[1]?.trim() || 'default-token-change-me';

// CORS for frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Auth middleware
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const authToken = auth.slice(7);
  if (authToken !== validToken) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  next();
}

// Sync endpoint
app.post('/api/sync', authenticate, (req, res) => {
  console.log(`[${new Date().toISOString()}] Sync triggered`);

  const child = spawn('node', ['sync-all.js', '5'], {
    cwd: process.cwd(),
    env: { ...process.env }
  });

  let output = '';

  child.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    process.stdout.write(text);
  });

  child.stderr.on('data', (data) => {
    process.stderr.write(data.toString());
  });

  child.on('close', (code) => {
    console.log(`[${new Date().toISOString()}] Sync completed with code ${code}`);
    res.json({ success: code === 0, code, output: output.slice(-2000) });
  });

  child.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Sync failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------------- Cloudflare Web Analytics proxy ----------------
// dumuqiao dashboard fetches real visit data from here.
// Reads siteTag + GraphQL endpoint from env, never exposes the API token to the browser.

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'ab574da844c911d7fa11c708f29e237e';
const WA_SITE_TAG = process.env.WA_SITE_TAG || 'e3eabceca1c04449b3f803eef49e9526';
const WA_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const WA_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

function waQuery(graphql) {
  return fetch(WA_GRAPHQL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + WA_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: graphql })
  }).then(r => r.json());
}

app.get('/api/analytics', async (req, res) => {
  if (!WA_TOKEN) {
    return res.status(500).json({ error: 'CLOUDFLARE_API_TOKEN not configured on server' });
  }

  const days = Math.min(parseInt(req.query.days, 10) || 7, 30);
  const end = new Date().toISOString().slice(0, 13) + ':00:00Z';
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 13) + ':00:00Z';

  const q = `query {
    viewer {
      accounts(filter: { accountTag: "${CLOUDFLARE_ACCOUNT_ID}" }) {
        total: rumPageloadEventsAdaptiveGroups(limit: 1, filter: { siteTag: "${WA_SITE_TAG}", datetime_geq: "${start}", datetime_leq: "${end}" }) { count sum { visits } }
        paths: rumPageloadEventsAdaptiveGroups(limit: 30, filter: { siteTag: "${WA_SITE_TAG}", datetime_geq: "${start}", datetime_leq: "${end}" }, orderBy: [sum_visits_DESC]) { count sum { visits } dimensions { requestPath requestHost refererHost deviceType userAgentBrowser countryName } }
        devices: rumPageloadEventsAdaptiveGroups(limit: 10, filter: { siteTag: "${WA_SITE_TAG}", datetime_geq: "${start}", datetime_leq: "${end}" }, orderBy: [sum_visits_DESC]) { count sum { visits } dimensions { deviceType } }
        browsers: rumPageloadEventsAdaptiveGroups(limit: 10, filter: { siteTag: "${WA_SITE_TAG}", datetime_geq: "${start}", datetime_leq: "${end}" }, orderBy: [sum_visits_DESC]) { count sum { visits } dimensions { userAgentBrowser } }
        countries: rumPageloadEventsAdaptiveGroups(limit: 10, filter: { siteTag: "${WA_SITE_TAG}", datetime_geq: "${start}", datetime_leq: "${end}" }, orderBy: [sum_visits_DESC]) { count sum { visits } dimensions { countryName } }
        daily: rumPageloadEventsAdaptiveGroups(limit: 100, filter: { siteTag: "${WA_SITE_TAG}", datetime_geq: "${start}", datetime_leq: "${end}" }, orderBy: [date_ASC]) { count sum { visits } dimensions { date } }
      }
    }
  }`;

  try {
    const data = await waQuery(q);
    if (data.errors) {
      return res.status(502).json({ error: 'Cloudflare GraphQL error', detail: data.errors });
    }
    const acc = data.data.viewer.accounts[0];
    res.json({
      siteTag: WA_SITE_TAG,
      range: { start, end, days },
      totalVisits: acc.total?.[0]?.sum?.visits ?? 0,
      paths: acc.paths || [],
      devices: acc.devices || [],
      browsers: acc.browsers || [],
      countries: acc.countries || [],
      daily: acc.daily || []
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Sync server listening on port ${PORT}`);
});
