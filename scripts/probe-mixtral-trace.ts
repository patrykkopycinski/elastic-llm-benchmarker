import dotenv from 'dotenv';
import { ModelDiscoveryService } from '../src/services/model-discovery.js';
dotenv.config();
const svc = new ModelDiscoveryService(process.env.HUGGINGFACE_TOKEN ?? '', [], 'debug');
const r = await svc.discover({ search: 'mixtral', sort: 'downloads', limit: 30, minContextWindow: 128000, minParameterCount: 24_000_000_000 });
console.log('DONE ids:', JSON.stringify(r.models.map(m=>({id:m.id, ctx:m.contextWindow, params:m.parameterCount}))));
