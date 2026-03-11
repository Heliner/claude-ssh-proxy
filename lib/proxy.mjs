#!/usr/bin/env node

/**
 * claude-ssh-proxy - Local API Proxy Server
 *
 * Runs on the developer's Mac, forwards HTTP requests to Anthropic API over HTTPS.
 * Supports SSE streaming for Claude Code CLI.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const DEFAULT_PORT = 18080;
const DEFAULT_HOST = '127.0.0.1';
const UPSTREAM = 'api.anthropic.com';

// --- Logging ---
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLogLevel = LOG_LEVELS.info;

function log(level, ...args) {
  if (LOG_LEVELS[level] >= currentLogLevel) {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    if (level === 'error') {
      console.error(prefix, ...args);
    } else {
      console.log(prefix, ...args);
    }
  }
}

// --- Auth Token (optional simple bearer token) ---
let authToken = null;

function checkAuth(req, res) {
  if (!authToken) return true;
  const header = req.headers['x-proxy-token'] || '';
  if (header === authToken) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing x-proxy-token' }));
  log('warn', `Auth failed from ${req.socket.remoteAddress}`);
  return false;
}

// --- Request Stats ---
const stats = {
  totalRequests: 0,
  activeRequests: 0,
  totalBytes: 0,
  errors: 0,
  startTime: Date.now(),
};

// --- Core Proxy Handler ---
function handleRequest(req, res) {
  // Health check endpoint
  if (req.url === '/__health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.floor((Date.now() - stats.startTime) / 1000),
      requests: stats.totalRequests,
      active: stats.activeRequests,
      errors: stats.errors,
    }));
    return;
  }

  // Auth check
  if (!checkAuth(req, res)) return;

  stats.totalRequests++;
  stats.activeRequests++;

  const startTime = Date.now();
  const method = req.method;
  const path = req.url;

  log('info', `→ ${method} ${path}`);

  // Build upstream headers, remove proxy-specific ones
  const upstreamHeaders = { ...req.headers };
  delete upstreamHeaders['host'];
  delete upstreamHeaders['x-proxy-token'];
  upstreamHeaders['host'] = UPSTREAM;

  const options = {
    hostname: UPSTREAM,
    port: 443,
    path: path,
    method: method,
    headers: upstreamHeaders,
    // Keep connection alive for performance
    agent: keepAliveAgent,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    const statusCode = proxyRes.statusCode;
    const isSSE = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

    log('info', `← ${statusCode} ${method} ${path}${isSSE ? ' [SSE]' : ''}`);

    // Copy response headers
    const responseHeaders = { ...proxyRes.headers };

    // Ensure no buffering for SSE
    if (isSSE) {
      responseHeaders['cache-control'] = 'no-cache';
      responseHeaders['x-accel-buffering'] = 'no';
    }

    res.writeHead(statusCode, responseHeaders);

    let responseSize = 0;

    proxyRes.on('data', (chunk) => {
      responseSize += chunk.length;
      res.write(chunk);
    });

    proxyRes.on('end', () => {
      res.end();
      stats.activeRequests--;
      stats.totalBytes += responseSize;
      const elapsed = Date.now() - startTime;
      log('info', `✓ ${method} ${path} ${statusCode} ${responseSize}B ${elapsed}ms`);
    });

    proxyRes.on('error', (err) => {
      log('error', `Upstream response error: ${err.message}`);
      stats.errors++;
      stats.activeRequests--;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Bad Gateway', detail: err.message }));
    });
  });

  proxyReq.on('error', (err) => {
    log('error', `Upstream request error: ${err.message}`);
    stats.errors++;
    stats.activeRequests--;
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Bad Gateway', detail: err.message }));
  });

  // Set a generous timeout for long-running SSE streams
  proxyReq.setTimeout(300000); // 5 minutes

  // Pipe request body to upstream
  req.pipe(proxyReq);
}

// --- HTTPS Keep-Alive Agent ---
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  keepAliveMsecs: 30000,
});

// --- Start Server ---
export function startProxy(options = {}) {
  const port = options.port || parseInt(process.env.PROXY_PORT) || DEFAULT_PORT;
  const host = options.host || process.env.PROXY_HOST || DEFAULT_HOST;
  authToken = options.token || process.env.PROXY_TOKEN || null;

  if (options.debug) {
    currentLogLevel = LOG_LEVELS.debug;
  }

  const server = http.createServer(handleRequest);

  // Disable response buffering at server level
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 120000;
  server.requestTimeout = 300000; // 5 min for long SSE streams

  server.listen(port, host, () => {
    log('info', `Claude SSH Proxy started on ${host}:${port}`);
    log('info', `Forwarding to https://${UPSTREAM}`);
    if (authToken) {
      log('info', `Auth token required: yes`);
    }
    log('info', `Health check: http://${host}:${port}/__health`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('error', `Port ${port} already in use. Proxy may already be running.`);
      process.exit(1);
    }
    log('error', `Server error: ${err.message}`);
  });

  // Graceful shutdown
  function shutdown(signal) {
    log('info', `Received ${signal}, shutting down...`);
    server.close(() => {
      log('info', 'Proxy stopped.');
      process.exit(0);
    });
    // Force exit after 5s
    setTimeout(() => process.exit(0), 5000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

// --- CLI entry ---
if (process.argv[1] && process.argv[1].endsWith('proxy.mjs')) {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port': case '-p':
        opts.port = parseInt(args[++i]);
        break;
      case '--host': case '-h':
        opts.host = args[++i];
        break;
      case '--token': case '-t':
        opts.token = args[++i];
        break;
      case '--debug': case '-d':
        opts.debug = true;
        break;
      case '--help':
        console.log(`
claude-ssh-proxy - Local API relay for Claude Code over SSH

Usage: node proxy.mjs [options]

Options:
  -p, --port <port>    Listen port (default: 18080, env: PROXY_PORT)
  -h, --host <host>    Listen host (default: 127.0.0.1, env: PROXY_HOST)
  -t, --token <token>  Auth token for x-proxy-token header (env: PROXY_TOKEN)
  -d, --debug          Enable debug logging
      --help           Show this help
`);
        process.exit(0);
    }
  }

  startProxy(opts);
}
