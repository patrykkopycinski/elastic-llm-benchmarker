import dotenv from 'dotenv';
dotenv.config();
const HF_API_BASE = 'https://huggingface.co';
const token = process.env.HUGGINGFACE_TOKEN ?? '';
async function fetchWithAuth(url: string) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { headers });
}
const url = `${HF_API_BASE}/api/models?${new URLSearchParams({ search: 'mixtral', limit: '100', full: 'true', config: 'true', sort: 'downloads' })}`;
const res = await fetchWithAuth(url);
const data = (await res.json()) as any[];
console.log('total', data.length, 'unique ids', new Set(data.map((m) => m.id)).size);
const cloudyu = data.filter((m) => m.id.includes('cloudyu/Mixtral_34Bx2_MoE_60B'));
console.log('cloudyu entries:', cloudyu.length);
console.log(JSON.stringify(cloudyu, null, 2).slice(0, 2000));
