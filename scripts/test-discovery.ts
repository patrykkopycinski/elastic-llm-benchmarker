import dotenv from 'dotenv';
import { ModelDiscoveryService } from '../src/services/model-discovery.js';

dotenv.config();

const hw = {
  gpuType: 'nvidia-a100-80gb',
  gpuCount: 2,
  ramGb: 340,
  cpuCores: 24,
  diskGb: 1000,
  machineType: 'a2-ultragpu-2g',
};

// Empty evaluated list => "accepted" means "qualifying AND hardware-fit AND
// available", regardless of whether we've benchmarked it before. This isolates
// SUPPLY (does the feed contain ≥7B/128k models at all?) from the
// already-evaluated skip the live daemon applies.
const svc = new ModelDiscoveryService(process.env.HUGGINGFACE_TOKEN ?? '', [], 'warn', hw);

const floors = { minContextWindow: 128_000, minParameterCount: 24 * 1_000_000_000, limit: 30 };

const probes: Array<{ label: string; search?: string; sort?: string }> = [
  { label: 'downloads (default)', sort: 'downloads' },
  { label: 'recency (lastModified)', sort: 'lastModified' },
  { label: 'search=instruct sort=downloads', search: 'instruct', sort: 'downloads' },
  { label: 'search=70b instruct sort=downloads', search: '70b instruct', sort: 'downloads' },
  { label: 'search=mistral small sort=downloads', search: 'mistral small', sort: 'downloads' },
  { label: 'search=qwen instruct sort=downloads', search: 'qwen instruct', sort: 'downloads' },
];

for (const p of probes) {
  const r = await svc.discover({ ...floors, ...(p.search ? { search: p.search } : {}), sort: p.sort });
  console.log(
    `[${p.label}] accepted=${r.models.length}/${r.totalScanned} scanned  →  ${r.models
      .map((m) => m.id)
      .slice(0, 8)
      .join(', ')}`,
  );
}
