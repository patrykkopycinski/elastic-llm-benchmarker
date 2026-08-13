import dotenv from 'dotenv';
import { ModelDiscoveryService } from '../src/services/model-discovery.js';
dotenv.config();
const svc = new ModelDiscoveryService(process.env.HUGGINGFACE_TOKEN ?? '', [], 'warn');
const r = await svc.discover({ search: 'mixtral', sort: 'downloads', limit: 30, minContextWindow: 128000, minParameterCount: 24_000_000_000 });
console.log('accepted', r.models.length, 'scanned', r.totalScanned, 'rejected', r.totalRejected);
console.log(JSON.stringify(r.rejectionBreakdown, null, 2));
console.log('ids:', JSON.stringify(r.models.map(m=>m.id)));
