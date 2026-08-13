import dotenv from 'dotenv';
import { ModelDiscoveryService } from '../src/services/model-discovery.js';
import { HardwareProfileRegistry } from '../src/services/hardware-profiles.js';

dotenv.config();
const profileRegistry = new HardwareProfileRegistry();
const profile = profileRegistry.getProfile('2xa100-80gb');
const svc = new ModelDiscoveryService(process.env.HUGGINGFACE_TOKEN ?? '', [], 'warn', profile?.hardware);

for (const probe of ['instruct', 'glm-4.5', 'mistral small', 'mixtral']) {
  const r = await svc.discover({ search: probe, sort: 'downloads', limit: 30, minContextWindow: 128000, minParameterCount: 24_000_000_000 });
  console.log(`\n[${probe}] accepted=${r.models.length}  ids=${JSON.stringify(r.models.map((m) => m.id))}`);
}
