import { createHash } from 'node:crypto';
import type { WorkerFile } from './executeWorker.js';
/** FileDiff.Info.patch and Session.Message.Assistant.Tool are copied from v2.
 * No local synthetic diff, no fabricated command execution or test success.
 */
export function openCodeFiles(diffs: unknown[], messages: unknown[], limit: number): WorkerFile[] {
 const files: WorkerFile[] = []; let bytes = 0;
 const add = (relativePath: string, text: string) => {
  const data = Buffer.from(text); bytes += data.length;
  if (bytes > Math.min(limit, 1048576)) throw new Error('OpenCode artifact output bound exceeded');
  files.push({ relativePath, size: data.length, contentBase64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') });
 };
 const patches = diffs.map((value: any) => {
  if (!value || typeof value.file !== 'string' || typeof value.patch !== 'string' || !['added', 'deleted', 'modified'].includes(value.status) || !Number.isSafeInteger(value.additions) || value.additions < 0 || !Number.isSafeInteger(value.deletions) || value.deletions < 0) throw new Error('Malformed OpenCode v2 file diff');
  return value.patch;
 });
 if (patches.some(patch => patch.length > 0)) add('code.diff', patches.join(''));
 const entries: string[] = [];
 for (const message of messages as any[]) {
  if (message?.type === 'shell') {
   entries.push(`command=${JSON.stringify(message.command)}\nstatus=${message.status}\nexecuted=recorded-shell-message\nexit=${message.exit ?? 'unknown'}\n${typeof message.output?.output === 'string' ? message.output.output : '[no captured output]'}\ntruncated=${message.output?.truncated ?? 'unknown'}`);
  }
  if (message?.type !== 'assistant' || !Array.isArray(message.content)) continue;
  for (const tool of message.content) {
   if (tool?.type !== 'tool' || tool.name !== 'shell' || !tool.state) continue;
   const output = Array.isArray(tool.state.content) ? tool.state.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n') : '[no captured output]';
   entries.push(`command=${JSON.stringify(tool.state.input?.command ?? '[unavailable]')}\nstatus=${tool.state.status}\nexecuted=${typeof tool.executed === 'boolean' ? tool.executed : 'unknown'}\nexit=${tool.state.metadata?.exit ?? 'unknown'}\n${output}\n${tool.state.error ? 'error=' + JSON.stringify(tool.state.error) : ''}`);
  }
 }
 add('tests.log', entries.length ? `Recorded shell observations. Commands are not automatically classified as tests; inspect command, status and output.\n\n${entries.join('\n\n')}\n` : 'No shell execution was recorded. Test execution is not verified.\n');
 return files;
}
