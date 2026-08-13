export interface HfTreeFile {
  path: string;
  size?: number;
  type?: string;
}

export interface ServedWeightSizeResult {
  /** Physical bytes for the selected served safetensors family. */
  bytes: number;
  /** Physical GB using 1024^3. */
  gb: number;
  /** Number of shards selected for the served family. */
  shardCount: number;
  /** Expected shard count parsed from the `of-NNNNNN` suffix, when present. */
  expectedShardCount: number | null;
  /** Root file family that was selected, e.g. `model` or `consolidated`. */
  family: string;
  /** Selected shard paths, sorted. */
  paths: string[];
  /** Duplicate/non-served families seen at repository root. */
  alternateFamilies: Array<{ family: string; shardCount: number; bytes: number }>;
  /** Non-root/duplicate packaging paths ignored before family selection. */
  ignoredPaths: string[];
}

const DUPLICATE_PACKAGE_DIRS = new Set([
  'original',
  'metal',
  'gguf',
  'onnx',
  'mlx',
  'awq',
  'gptq',
  'int4',
  'fp8',
  'nvfp4',
  'mxfp4',
]);

interface CandidateShard {
  path: string;
  size: number;
  family: string;
  groupKey: string;
  index: number | null;
  total: number | null;
}

function rootDirectory(path: string): string | null {
  const slash = path.indexOf('/');
  return slash === -1 ? null : path.slice(0, slash).toLowerCase();
}

function parseShard(path: string): { family: string; index: number | null; total: number | null } {
  const base = path.split('/').pop() ?? path;
  const numbered = base.match(/^(.+?)-0*(\d+)-of-0*(\d+)\.safetensors$/i);
  if (numbered?.[1] && numbered[2] && numbered[3]) {
    return {
      family: numbered[1],
      index: Number.parseInt(numbered[2], 10),
      total: Number.parseInt(numbered[3], 10),
    };
  }
  const bare = base.match(/^(.+?)\.safetensors$/i);
  return { family: bare?.[1] ?? base, index: null, total: null };
}

function shardGroupKey(shard: { family: string; total: number | null }): string {
  return `${shard.family}:${shard.total ?? 'single'}`;
}

/**
 * Sum the physical served safetensors shard set from a Hugging Face tree listing.
 *
 * This deliberately ignores HF parameter-count metadata and safetensors index
 * totals. Quantized repos can report packed MXFP4 as unpacked `U8`, FP8 index
 * totals can reflect logical BF16 size, and unpaginated tree listings can return
 * plausible partial shard sets. Physical shard bytes win.
 */
export function summarizeServedWeightSize(files: HfTreeFile[]): ServedWeightSizeResult | null {
  const ignoredPaths: string[] = [];
  const candidates: CandidateShard[] = [];

  for (const file of files) {
    if (file.type && file.type !== 'file') continue;
    if (!file.path.endsWith('.safetensors')) continue;
    if (typeof file.size !== 'number' || file.size <= 0) continue;

    const root = rootDirectory(file.path);
    if (root && DUPLICATE_PACKAGE_DIRS.has(root)) {
      ignoredPaths.push(file.path);
      continue;
    }

    const shard = parseShard(file.path);
    candidates.push({ path: file.path, size: file.size, groupKey: shardGroupKey(shard), ...shard });
  }

  if (candidates.length === 0) return null;

  const families = new Map<string, CandidateShard[]>();
  for (const shard of candidates) {
    const existing = families.get(shard.groupKey) ?? [];
    existing.push(shard);
    families.set(shard.groupKey, existing);
  }

  const ranked = Array.from(families.values())
    .map((shards) => ({
      family: shards[0]?.family ?? 'unknown',
      groupKey: shards[0]?.groupKey ?? 'unknown',
      shards: shards.sort((a, b) => a.path.localeCompare(b.path)),
      bytes: shards.reduce((sum, shard) => sum + shard.size, 0),
      expectedShardCount: inferExpectedShardCount(shards),
    }))
    .sort((a, b) => {
      const completenessA = a.expectedShardCount === null || a.expectedShardCount === a.shards.length ? 1 : 0;
      const completenessB = b.expectedShardCount === null || b.expectedShardCount === b.shards.length ? 1 : 0;
      if (completenessA !== completenessB) return completenessB - completenessA;
      if (a.family === 'model' && b.family !== 'model') return -1;
      if (b.family === 'model' && a.family !== 'model') return 1;
      const numberedA = a.expectedShardCount === null ? 0 : 1;
      const numberedB = b.expectedShardCount === null ? 0 : 1;
      if (numberedA !== numberedB) return numberedB - numberedA;
      return b.bytes - a.bytes;
    });

  const selected = ranked[0];
  if (!selected) return null;

  if (
    selected.expectedShardCount !== null &&
    selected.expectedShardCount !== selected.shards.length
  ) {
    throw new Error(
      `Incomplete safetensors shard set for ${selected.family}: found ${selected.shards.length}/${selected.expectedShardCount}`,
    );
  }

  return {
    bytes: selected.bytes,
    gb: selected.bytes / 1024 ** 3,
    shardCount: selected.shards.length,
    expectedShardCount: selected.expectedShardCount,
    family: selected.family,
    paths: selected.shards.map((shard) => shard.path),
    alternateFamilies: ranked
      .filter((entry) => entry.groupKey !== selected.groupKey)
      .map((entry) => ({ family: entry.family, shardCount: entry.shards.length, bytes: entry.bytes })),
    ignoredPaths,
  };
}

function inferExpectedShardCount(shards: CandidateShard[]): number | null {
  const totals = new Set(shards.map((shard) => shard.total).filter((total): total is number => total !== null));
  if (totals.size === 0) return null;
  if (totals.size > 1) {
    throw new Error(`Conflicting safetensors shard totals: ${Array.from(totals).join(', ')}`);
  }
  return Array.from(totals)[0] ?? null;
}

export interface HfFetchResponse {
  ok: boolean;
  json(): Promise<unknown>;
  headers: { get(name: string): string | null };
}

export type HfFetch = (input: string, init?: { headers?: Record<string, string> }) => Promise<HfFetchResponse>;

export async function fetchServedWeightSize(
  modelId: string,
  fetchImpl?: HfFetch,
  hfApiToken?: string,
): Promise<ServedWeightSizeResult | null> {
  const doFetch = fetchImpl ?? (globalThis as unknown as { fetch?: HfFetch }).fetch;
  if (!doFetch) return null;
  const headers: Record<string, string> = { 'User-Agent': 'elastic-llm-benchmarker' };
  if (hfApiToken) headers.Authorization = `Bearer ${hfApiToken}`;

  const files: HfTreeFile[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(`https://huggingface.co/api/models/${modelId}/tree/main`);
    url.searchParams.set('recursive', '1');
    url.searchParams.set('expand', '1');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await doFetch(url.toString(), { headers });
    if (!response.ok) return null;
    const page = (await response.json()) as HfTreeFile[];
    files.push(...page);

    const link = response.headers.get('link');
    cursor = parseNextCursor(link);
  } while (cursor);

  return summarizeServedWeightSize(files);
}

function parseNextCursor(link: string | null): string | null {
  if (!link) return null;
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  if (!match?.[1]) return null;
  const url = new URL(match[1]);
  return url.searchParams.get('cursor');
}

export const testInternals = { parseNextCursor };
