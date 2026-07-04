import { createServer } from 'http';
import { TunnelService } from '../src/services/tunnel-service.js';

/**
 * Real end-to-end smoke test of the cloudflared tunnel provider.
 * Starts a throwaway local HTTP server, opens a Cloudflare quick tunnel to it
 * via the actual `cloudflared` CLI, and verifies the public URL routes back to
 * the local server. Proves the provider mints and exposes a working tunnel
 * without any ngrok reserved-domain contention.
 */
async function main(): Promise<void> {
  const PORT = 18987;
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-model' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('smoke-ok');
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`[smoke] local server listening on 127.0.0.1:${PORT}`);

  const tunnel = new TunnelService({
    config: {
      enabled: true,
      provider: 'cloudflared',
      ngrokRegion: 'us',
      localPort: PORT,
      timeoutMs: 60_000,
      retryAttempts: 1,
      retryDelayMs: 3_000,
    },
    logLevel: 'info',
  });

  let exitCode = 1;
  try {
    const result = await tunnel.connect();
    if (!result.success || !result.tunnel) {
      console.error('[smoke] FAIL: tunnel did not connect:', result.error);
      return;
    }
    const url = result.tunnel.publicUrl;
    console.log(`[smoke] tunnel up: ${url} (provider=${result.tunnel.provider})`);
    if (!/\.trycloudflare\.com$/.test(new URL(url).hostname)) {
      console.error('[smoke] FAIL: expected a *.trycloudflare.com URL, got', url);
      return;
    }

    // Cloudflare edge needs a moment to become reachable after the URL is minted.
    let ok = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const body = (await res.json()) as { data?: Array<{ id: string }> };
          if (body.data?.[0]?.id === 'smoke-model') {
            ok = true;
            break;
          }
        }
      } catch {
        // edge not ready yet
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    if (ok) {
      console.log('[smoke] PASS: public URL routed to local server and returned expected model');
      exitCode = 0;
    } else {
      console.error('[smoke] FAIL: public URL never returned the expected payload');
    }
  } finally {
    await tunnel.disconnect();
    server.close();
    process.exit(exitCode);
  }
}

void main();
