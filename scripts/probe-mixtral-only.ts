import dotenv from 'dotenv';
import { ModelDiscoveryService } from '../src/services/model-discovery.js';
import { HardwareProfileRegistry } from '../src/services/hardware-profiles.js';

dotenv.config();
const profileRegistry = new HardwareProfileRegistry();
const profile = profileRegistry.getProfile('2xa100-80gb');
const svc = new ModelDiscoveryService(process.env.HUGGINGFACE_TOKEN ?? '', [], 'warn', profile?.hardware);
const r = await svc.discover({ search: 'mixtral', sort: 'downloads', limit: 30, minContextWindow: 128000, minParameterCount: 24_000_000_000 });
console.log(`accepted=${r.models.length} scanned=${r.totalScanned} unique=${new Set(r.models.map(m=>m.id)).size}`);
console.log(JSON.stringify(r.models.map(m=>m.id)));
