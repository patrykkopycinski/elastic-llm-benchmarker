import dotenv from 'dotenv';
dotenv.config();
const HF_API_BASE = 'https://huggingface.co';
const token = process.env.HUGGINGFACE_TOKEN ?? '';
async function fetchWithAuth(url: string) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { headers });
}
function parseNextLink(linkHeader: string | null) {
  if (!linkHeader) return undefined;
  const m = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return m?.[1];
}
let url: string | undefined = `${HF_API_BASE}/api/models?${new URLSearchParams({ search: 'mixtral', limit: '100', full: 'true', config: 'true', sort: 'downloads' })}`;
const allIds: string[] = [];
for (let i = 0; i < 10 && url; i++) {
  const res: Response = await fetchWithAuth(url);
  const data = (await res.json()) as any[];
  allIds.push(...data.map((m) => m.id));
  console.log(`page ${i}: count=${data.length} cloudyuIdx=${data.findIndex(m=>m.id==='cloudyu/Mixtral_34Bx2_MoE_60B')}`);
  url = parseNextLink(res.headers.get('link'));
}
console.log('total fetched', allIds.length, 'unique', new Set(allIds).size);
console.log('cloudyu appearances across all pages:', allIds.filter(id => id === 'cloudyu/Mixtral_34Bx2_MoE_60B').length);
