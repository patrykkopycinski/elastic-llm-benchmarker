import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures', 'feature-profiles', 'attack-discovery');

interface ExpectedRow {
  repoId: string;
  fixtureKey: string;
  campaignOutcome: string;
  expectedGateVerdict: 'pass' | 'investigate' | 'reject';
  c2FindingIds: string[];
  note: string;
}

interface ExpectedTable {
  rows: ExpectedRow[];
}

function loadExpectedTable(): ExpectedTable {
  const raw = readFileSync(join(FIXTURES_DIR, 'expected.json'), 'utf-8');
  return JSON.parse(raw) as ExpectedTable;
}

function loadC2FindingIds(): Set<string> {
  const raw = readFileSync(join(FIXTURES_DIR, 'c2-findings.txt'), 'utf-8');
  const ids = raw.match(/C2-\d+/g) ?? [];
  return new Set(ids);
}

describe('attack-discovery backtest table (expected.json)', () => {
  const table = loadExpectedTable();
  const c2Ids = loadC2FindingIds();

  it('has a row for every fixture model named in gate-step2-spec.md item 3', () => {
    const expectedFixtureKeys = [
      'qwen3.8-27b',
      'gpt-oss-120b',
      'gemma-4-26b-a4b',
      'magistral-small-2509',
      'mistral-small-3.2-24b',
      'glm-4.7-flash',
    ];
    const actualFixtureKeys = table.rows.map((row) => row.fixtureKey).sort();
    expect(actualFixtureKeys).toEqual([...expectedFixtureKeys].sort());
  });

  it('every row cites at least one C2 finding id that exists in the frozen c2-findings.txt', () => {
    expect(c2Ids.size).toBeGreaterThan(0);
    for (const row of table.rows) {
      expect(row.c2FindingIds.length).toBeGreaterThan(0);
      for (const id of row.c2FindingIds) {
        expect(c2Ids.has(id), `row ${row.fixtureKey} cites ${id}, which is not present in c2-findings.txt`).toBe(
          true
        );
      }
    }
  });

  it('every row has a non-empty verdict and note', () => {
    for (const row of table.rows) {
      expect(['pass', 'investigate', 'reject']).toContain(row.expectedGateVerdict);
      expect(row.note.length).toBeGreaterThan(0);
      expect(row.campaignOutcome.length).toBeGreaterThan(0);
    }
  });
});
