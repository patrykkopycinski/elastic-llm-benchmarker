import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalConnector } from '../../src/services/local-connector.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('LocalConnector', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `benchmarker-test-${Date.now()}`);
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // cleanup is best-effort in tests
    }
  });

  it('has type "local"', () => {
    const connector = new LocalConnector({ outputDir: testDir });
    expect(connector.type).toBe('local');
  });

  it('initialize creates directory structure', async () => {
    const connector = new LocalConnector({ outputDir: testDir });
    const result = await connector.initialize();
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'benchmarks'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'recommendations'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'stage2'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'stage3'))).toBe(true);
  });

  it('saveBenchmarkResult writes a JSON file', async () => {
    const connector = new LocalConnector({ outputDir: testDir });
    await connector.initialize();

    const result = await connector.saveBenchmarkResult({
      modelId: 'test/model-1',
      timestamp: '2024-01-01T00:00:00Z',
    } as never);

    expect(result.success).toBe(true);

    const files = fs.readdirSync(path.join(testDir, 'benchmarks'));
    expect(files.length).toBe(1);
    expect(files[0]).toContain('test_model-1');
  });

  it('saveRecommendationReport writes report + latest + index', async () => {
    const connector = new LocalConnector({ outputDir: testDir });
    await connector.initialize();

    const report = {
      reportId: 'rpt-001',
      modelId: 'test/model-1',
      verdict: 'support',
      confidence: 'high',
      evaluatedAt: '2024-01-01T00:00:00Z',
    };

    const result = await connector.saveRecommendationReport(report as never);
    expect(result.success).toBe(true);

    const recDir = path.join(testDir, 'recommendations');
    expect(fs.existsSync(path.join(recDir, 'rpt-001.json'))).toBe(true);
    expect(fs.existsSync(path.join(recDir, 'test_model-1_latest.json'))).toBe(true);
    expect(fs.existsSync(path.join(recDir, 'index.jsonl'))).toBe(true);

    const index = fs.readFileSync(path.join(recDir, 'index.jsonl'), 'utf-8');
    const entry = JSON.parse(index.trim());
    expect(entry.reportId).toBe('rpt-001');
    expect(entry.verdict).toBe('support');
  });

  it('saveStage2Result writes a JSON file', async () => {
    const connector = new LocalConnector({ outputDir: testDir });
    await connector.initialize();

    const result = await connector.saveStage2Result({
      runId: 'run-001',
    } as never);

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'stage2', 'run-001.json'))).toBe(true);
  });

  it('saveStage3Result writes a JSON file', async () => {
    const connector = new LocalConnector({ outputDir: testDir });
    await connector.initialize();

    const result = await connector.saveStage3Result({
      runId: 'run-002',
    } as never);

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'stage3', 'run-002.json'))).toBe(true);
  });

  it('close completes without error', async () => {
    const connector = new LocalConnector({ outputDir: testDir });
    await expect(connector.close()).resolves.toBeUndefined();
  });

  it('sanitizes model IDs with special characters', async () => {
    const connector = new LocalConnector({ outputDir: testDir });
    await connector.initialize();

    await connector.saveBenchmarkResult({
      modelId: 'org/model:latest@v2',
      timestamp: '2024-01-01',
    } as never);

    const files = fs.readdirSync(path.join(testDir, 'benchmarks'));
    expect(files[0]).not.toContain(':');
    expect(files[0]).not.toContain('@');
  });
});
