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

let url = `${HF_API_BASE}/api/models?${new URLSearchParams({ search: 'mixtral', limit: '100', full: 'true', config: 'true', sort: 'downloads' })}`;
for (let i = 0; i < 4 && url; i++) {
  const res = await fetchWithAuth(url);
  const data = (await res.json()) as any[];
  console.log(`page ${i}: url=${url.slice(0, 120)}...`);
  console.log(`  status=${res.status} count=${data.length} first3=${JSON.stringify(data.slice(0,3).map(m=>m.id))}`);
  console.log(`  link=${res.headers.get('link')?.slice(0,150)}`);
  url = parseNextLink(res.headers.get('link'));
}
