import { runBackground } from './workflow.js';
import { runPurposeBackground } from './purpose-runner.js';
import { VERSION } from './core.js';

// Each subsystem chooses one role. A failure in life/Reflect-style work does
// not prevent purpose reconciliation, and neither edits Dream's private data.
export async function runTasks(client, store, opts = {}) {
  const invoke = async fn => { try { return await fn(client, store, opts); } catch (e) { return { status: 'error', message: String(e.message || e) }; } };
  const purpose = await invoke(runPurposeBackground);
  const life = await invoke(runBackground);
  const needsAttention = result => ['error', 'partial', 'skipped', 'uncertain', 'unsupported'].includes(result.status) || result.warnings?.length > 0;
  return { status: [purpose, life].some(needsAttention) ? 'partial' : 'ok', appVersion: VERSION, purpose, life,
    message: `主动交互：${purpose.message}；生活整理：${life.message}` };
}
