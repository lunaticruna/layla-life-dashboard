import { runBackground } from './workflow.js';
import { runPurposeBackground } from './purpose-runner.js';

// Each subsystem chooses one role. A failure in life/Reflect-style work does
// not prevent purpose reconciliation, and neither edits Dream's private data.
export async function runTasks(client, store, opts = {}) {
  const invoke = async fn => { try { return await fn(client, store, opts); } catch (e) { return { status: 'error', message: String(e.message || e) }; } };
  const purpose = await invoke(runPurposeBackground);
  const life = await invoke(runBackground);
  return { status: [purpose.status, life.status].includes('error') ? 'partial' : 'ok', purpose, life,
    message: `主动交互：${purpose.message}；生活整理：${life.message}` };
}
