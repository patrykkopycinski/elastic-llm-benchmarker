import dotenv from 'dotenv';
import { ModelDiscoveryService } from '../src/services/model-discovery.js';
dotenv.config();
const svc: any = new ModelDiscoveryService(process.env.HUGGINGFACE_TOKEN ?? '', [], 'warn');
let pageNum = 0;
const gen = (svc as any).fetchModelPages({ search: 'mixtral', sort: 'downloads' });
// monkeypatch fetchWithAuth to log urls
const origFetch = svc.fetchWithAuth.bind(svc);
svc.fetchWithAuth = async (url: string) => {
  console.log(`FETCH: ${url}`);
  const res = await origFetch(url);
  console.log(`  -> link header: ${res.headers.get('link')?.slice(0,100)}`);
  return res;
};
for await (const page of gen) {
  console.log(`page ${pageNum}: len=${page.length} first=${page[0]?.id}`);
  pageNum++;
  if (pageNum > 3) break;
}
