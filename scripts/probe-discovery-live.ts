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

const svc = new ModelDiscoveryService(process.env.HUGGINGFACE_TOKEN ?? '', [], 'warn', hw);

const floors = { minContextWindow: 128_000, minParameterCount: 24 * 1_000_000_000, limit: 50 };

const probes: Array<{ label: string; search?: string; sort?: string }> = [
  { label: 'downloads (default)', sort: 'downloads' },
  { label: 'search=instruct sort=downloads', search: 'instruct', sort: 'downloads' },
  { label: 'search=mistral small sort=downloads', search: 'mistral small', sort: 'downloads' },
];

for (const p of probes) {
  const r = await svc.discover({ ...floors, ...(p.search ? { search: p.search } : {}), sort: p.sort });
  console.log(`\n=== [${p.label}] scanned=${r.totalScanned} rejected=${r.totalRejected} accepted=${r.models.length} ===`);
  console.log(JSON.stringify(r.rejectionBreakdown, null, 2));
}
