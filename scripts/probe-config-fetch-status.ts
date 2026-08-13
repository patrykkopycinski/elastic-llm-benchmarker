import dotenv from 'dotenv';
dotenv.config();

const HF_API_BASE = 'https://huggingface.co';
const token = process.env.HUGGINGFACE_TOKEN ?? '';

async function fetchWithAuth(url: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { headers });
}

async function searchModels(search: string, sort: string, limit: number): Promise<any[]> {
  const params = new URLSearchParams({
    search, sort, direction: '-1', limit: String(limit), full: 'true',
  });
  const res = await fetchWithAuth(`${HF_API_BASE}/api/models?${params.toString()}`);
  if (!res.ok) { console.error('search failed', res.status); return []; }
  return res.json();
}

const statusCounts: Record<string, number> = {};
const samplesByStatus: Record<string, string[]> = {};

async function probe(search: string, sort: string) {
  const models = await searchModels(search, sort, 100);
  for (const m of models) {
    const id = m.id;
    try {
      const res = await fetchWithAuth(`${HF_API_BASE}/${id}/resolve/main/config.json`);
      const key = String(res.status);
      statusCounts[key] = (statusCounts[key] ?? 0) + 1;
      if (!res.ok) {
        samplesByStatus[key] = samplesByStatus[key] ?? [];
        if (samplesByStatus[key].length < 5) samplesByStatus[key].push(id);
      }
    } catch (e) {
      statusCounts['fetch-error'] = (statusCounts['fetch-error'] ?? 0) + 1;
      samplesByStatus['fetch-error'] = samplesByStatus['fetch-error'] ?? [];
      if (samplesByStatus['fetch-error'].length < 5) samplesByStatus['fetch-error'].push(`${id}: ${String(e)}`);
    }
  }
}

await probe('mistral small', 'downloads');
await probe('instruct', 'downloads');

console.log('STATUS COUNTS:', JSON.stringify(statusCounts, null, 2));
console.log('SAMPLES:', JSON.stringify(samplesByStatus, null, 2));
