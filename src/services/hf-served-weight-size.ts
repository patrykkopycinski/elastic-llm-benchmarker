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
  const stem = bare?.[1] ?? base;
  // Repos that shard by layer rather than by `-of-` (e.g. `layers-0.safetensors`)
  // are one physical set: group on the stem, keep the trailing ordinal as index.
  const ordinal = stem.match(/^(.+?)[-_.]0*(\d+)$/);
  if (ordinal?.[1] && ordinal[2]) {
    return { family: ordinal[1], index: Number.parseInt(ordinal[2], 10), total: null };
  }
  return { family: stem, index: null, total: null };
}

function shardGroupKey(shard: { family: string; total: number | null }): string {
  return `${shard.family}:${shard.total ?? 'single'}`;
}

/**
 * A shard set is complete when its indices form one contiguous run.
 *
 * `-of-N` is only a hint: some published repos are 0-indexed, so a set declaring
 * `of-00002` legitimately ships `00000`, `00001`, `00002`. Trusting the declared
 * total alone rejects those as incomplete (observed on `openai/gpt-oss-20b`), so
 * the contiguous index run is authoritative and the declared total is advisory.
 */
function isCompleteShardSet(shards: CandidateShard[]): boolean {
  const indices = shards
    .map((shard) => shard.index)
    .filter((index): index is number => index !== null)
    .sort((a, b) => a - b);
  if (indices.length === 0) return shards.length === 1;
  if (indices.length !== shards.length) return false;
  const first = indices[0];
  if (first === undefined || first > 1) return false;
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] !== (indices[i - 1] as number) + 1) return false;
  }
  // A declared `-of-N` still bounds the set: N shards when 1-indexed, N+1 when
  // 0-indexed. Anything short of that is a truncated tree page, not a convention.
  const declared = shards.find((shard) => shard.total !== null)?.total ?? null;
  if (declared !== null) {
    const expected = first === 0 ? declared + 1 : declared;
    if (shards.length !== expected) return false;
  }
  return true;
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
      complete: isCompleteShardSet(shards),
    }))
    .sort((a, b) => {
      const completenessA = a.complete ? 1 : 0;
      const completenessB = b.complete ? 1 : 0;
      if (completenessA !== completenessB) return completenessB - completenessA;
      if (a.family === 'model' && b.family !== 'model') return -1;
      if (b.family === 'model' && a.family !== 'model') return 1;
      // A declared `-of-N` shard set is the served weights; a lone sibling file
      // (e.g. a merged `model.safetensors`) is alternate packaging even when bigger.
      const declaredA = a.expectedShardCount === null ? 0 : 1;
      const declaredB = b.expectedShardCount === null ? 0 : 1;
      if (declaredA !== declaredB) return declaredB - declaredA;
      return b.bytes - a.bytes;
    });

  const selected = ranked[0];
  if (!selected) return null;

  if (!selected.complete) {
    const expected = selected.expectedShardCount ?? 'contiguous';
    throw new Error(
      `Incomplete safetensors shard set for ${selected.family}: found ${selected.shards.length}/${expected}`,
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
