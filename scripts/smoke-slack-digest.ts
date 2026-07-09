/**
 * Local-capture validation for the Slack health digest.
 *
 * Stands up a throwaway HTTP listener on 127.0.0.1, points a real SlackNotifier
 * at it, and fires notifyHealthDigest() with a representative digest. The
 * captured POST body proves the real notifier code path (fetch → JSON blocks)
 * works end-to-end WITHOUT a real Slack webhook — no fabricated evidence, just
 * the actual payload the daemon would send once NOTIFICATIONS_WEBHOOK_URL is set.
 *
 * Run: npx tsx scripts/smoke-slack-digest.ts
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SlackNotifier, type HealthDigest } from '../src/services/slack-notifier.js';

async function main(): Promise<void> {
  let captured: unknown;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      captured = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('ok');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const webhookUrl = `http://127.0.0.1:${port}`;
  console.log(`[harness] local capture listener on ${webhookUrl}`);

  const notifier = new SlackNotifier({ webhookUrl, logLevel: 'error' });

  const digest: HealthDigest = {
    window: 'last 24h',
    signals: [
      { label: 'Completed (24h)', value: '2', alert: false },
      { label: 'Failed (24h)', value: '1', alert: false },
      { label: 'Queue depth', value: '0 pending', alert: false },
      { label: 'VM utilization', value: '32.5%', alert: false },
      { label: 'Est. VM cost (24h)', value: '$192.00', alert: false },
      { label: 'Golden-forward errors (24h)', value: '4', alert: true },
      { label: 'DLQ retriable (aging)', value: '1', alert: true },
    ],
  };

  const result = await notifier.notifyHealthDigest(digest);
  console.log(`[harness] notifier result: ${JSON.stringify(result)}`);
  console.log('[harness] captured Slack payload:');
  console.log(JSON.stringify(captured, null, 2));

  server.close();

  // Assertions: the notifier reported success and the captured payload is a
  // Slack blocks message whose header reflects the 2 breached signals.
  const payload = captured as { blocks?: Array<{ type: string; text?: { text?: string } }> };
  const header = payload?.blocks?.find((b) => b.type === 'header')?.text?.text ?? '';
  const ok =
    result.success === true &&
    Array.isArray(payload?.blocks) &&
    header.includes('2 alert');
  if (!ok) {
    console.error('[harness] FAIL — payload did not match expected Slack digest shape');
    process.exitCode = 1;
    return;
  }
  console.log(`[harness] PASS — real SlackNotifier posted a valid digest (header: "${header}")`);
}

void main();
