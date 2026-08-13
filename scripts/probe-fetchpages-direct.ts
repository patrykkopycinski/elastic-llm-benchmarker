import dotenv from 'dotenv';
import { ModelDiscoveryService } from '../src/services/model-discovery.js';
dotenv.config();
const svc: any = new ModelDiscoveryService(process.env.HUGGINGFACE_TOKEN ?? '', [], 'warn');
let pageNum = 0;
for await (const page of (svc as any).fetchModelPages({ search: 'mixtral', sort: 'downloads' })) {
  const cloudyuCount = page.filter((m: any) => m.id === 'cloudyu/Mixtral_34Bx2_MoE_60B').length;
  console.log(`page ${pageNum}: len=${page.length} first=${page[0]?.id} last=${page[page.length-1]?.id} cloudyuCount=${cloudyuCount}`);
  pageNum++;
}
