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

app.listen(PORT, () => {
  console.log(`Sync server listening on port ${PORT}`);
});
