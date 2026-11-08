import { createStore } from './store.js';
import { runTasks } from './task-runner.js';
// The bundler removes imports. Do not create a WebView or import the SDK here.
export async function run() {
  if (typeof layla === 'undefined') throw new Error('此任务需要在 Layla 的任务管理器中运行');
  console.info('生活与主动交互任务开始');
  const result = await runTasks(layla, createStore(layla));
  console.info(result.message);
  return result;
}
