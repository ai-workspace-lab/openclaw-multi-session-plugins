import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const fixture = vi.hoisted(() => ({ frames: [] as any[], commands: [] as string[][], mode: 'success', child: undefined as any, abortPrompt: undefined as undefined | (() => void) }));
vi.mock('node:child_process', () => ({ spawn: vi.fn((bin: string, args: string[]) => {
 fixture.commands.push([bin, ...args]);
 const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null as null | number, signalCode: null, kill: () => { if (fixture.mode === 'wrapper-stuck' && args[2] !== 'cancel') return true; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); return true; } });
 if (args[2] === 'cancel') {
  queueMicrotask(() => { child.stdout.write(JSON.stringify({ profile: args[3], runId: args[4], workerStopped: fixture.mode !== 'cancel-unconfirmed' }) + '\n'); child.exitCode = fixture.mode === 'cancel-fail' ? 1 : 0; child.emit('close', child.exitCode); });
  return child;
 }
 fixture.child = child;
 const send = (frame: any) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
 child.stdin.on('data', raw => {
  const f = JSON.parse(raw.toString()); fixture.frames.push(f);
  queueMicrotask(() => {
   if (f.method === 'initialize' && fixture.mode === 'protocol-fail') { child.stdout.write('invalid-frame\n'); return; }
   if (f.method === 'initialize' && fixture.mode === 'protocol-timeout') return;
   if (f.method === 'initialize') send({ id: f.id, result: f.params.provider ? { serverInfo: { name: 'deepseek-harness-sdk-runtime' } } : { protocolVersion: 1, agentInfo: { name: 'deepseek-harness-acp' } } });
   else if (f.method === 'session/new') send({ id: f.id, result: { sessionId: 'acp-session', configOptions: [{ id: 'model', options: [{ group: 'xworkmate', options: [{ value: '["xworkmate","test-model"]' }] }] }] } });
   else if (f.method === 'session/set_config_option' || f.method === 'session/close' || f.method === 'shutdown') send({ id: f.id, result: {} });
   else if (f.method === 'session/prompt' && fixture.abortPrompt) { fixture.abortPrompt(); }
   else if (f.method === 'session/prompt' && f.params.contentBlocks) {
    send({ id: f.id, result: { messageId: 'message-1' } });
    send({ method: 'session.status', params: { sessionId: f.params.sessionId, status: 'running' } });
    send({ method: 'session.event', params: { sessionId: f.params.sessionId, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'sdk-completed' }] } } } } });
    send({ method: 'session.event', params: { sessionId: f.params.sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });
    send({ method: 'session.status', params: { sessionId: f.params.sessionId, status: 'idle' } });
   } else if (f.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 'acp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'acp-completed' } } } });
    send({ id: f.id, result: { stopReason: 'end_turn' } });
   }
  });
 });
 return child;
}) }));
import { executeWorker, type WorkerConfig } from './executeWorker.js';
const config: WorkerConfig = { command: ['/usr/bin/sudo', '-n', '/usr/local/libexec/xworkmate-worker-launch'], stateRoot: '/var/lib/xworkmate-workers/runs', modelService: { baseUrl: 'https://models.example/v1', model: 'test-model', credentialEnvFile: '/run/xworkmate-workers/model.env' }, opencode: { baseUrl: 'http://127.0.0.1:4097', authEnvFile: '/run/xworkmate-workers/opencode.env' } };
const input = { prompt: 'hello', runId: '12345678-1234-4234-8234-123456789abc', workspaceDir: '/tmp/run', config };
describe('DSH pinned process fixtures', () => {
 it('ACP validates explicit unified route and settles before close', async () => {
  fixture.frames = []; fixture.commands = []; fixture.mode = 'success'; fixture.abortPrompt = undefined;
  expect(await executeWorker({ ...input, engine: 'dsh-acp' })).toMatchObject({ text: 'acp-completed' });
  expect(fixture.frames.find(f => f.method === 'session/new').params.cwd).toContain('/dsh-acp/');
  expect(fixture.frames.find(f => f.method === 'session/set_config_option').params.value).toBe('["xworkmate","test-model"]');
  expect(fixture.frames.at(-1).method).toBe('session/close'); expect(fixture.child.exitCode).toBe(0); expect(fixture.commands.at(-1)).toContain('cancel');
 });
 it('SDK returns only after durable turn ending and agent idle', async () => {
  fixture.frames = []; fixture.commands = []; fixture.mode = 'success'; fixture.abortPrompt = undefined;
  expect(await executeWorker({ ...input, engine: 'dsh-sdk' })).toMatchObject({ text: 'sdk-completed' });
  expect(fixture.frames[0].params.provider).toBe('xworkmate');
  expect(fixture.frames.at(-1).method).toBe('shutdown'); expect(fixture.child.exitCode).toBe(0); expect(fixture.commands.at(-1)).toContain('cancel');
 });
 it('always settles the restricted unit after protocol failure', async () => {
  fixture.frames = []; fixture.commands = []; fixture.mode = 'protocol-fail'; fixture.abortPrompt = undefined;
  await expect(executeWorker({ ...input, engine: 'dsh-acp' })).rejects.toThrow('Malformed worker JSON-RPC');
  expect(fixture.commands.at(-1)).toEqual(['/usr/bin/sudo', '-n', '/usr/local/libexec/xworkmate-worker-launch', 'cancel', 'dsh-acp', input.runId]);
 });
 it('blocks completion and artifact export if unit settlement fails', async () => {
  fixture.frames = []; fixture.commands = []; fixture.mode = 'cancel-fail'; fixture.abortPrompt = undefined;
  await expect(executeWorker({ ...input, engine: 'dsh-acp', config: { ...config, collectArtifacts: true } })).rejects.toThrow('DSH runtime cleanup');
  expect(fixture.commands.some(command => command.includes('export'))).toBe(false);
 });
 it('settles the systemd unit after SDK mid-turn abort without claiming rollback', async () => {
  const controller = new AbortController(); fixture.frames = []; fixture.commands = []; fixture.mode = 'success'; fixture.abortPrompt = () => controller.abort();
  await expect(executeWorker({ ...input, engine: 'dsh-sdk', signal: controller.signal })).rejects.toThrow('no mid-turn cancel');
  expect(fixture.commands.at(-1)).toContain('cancel'); fixture.abortPrompt = undefined;
 });
 it('settles the unit on timeout and rejects unconfirmed stop manifests', async () => {
  fixture.frames = []; fixture.commands = []; fixture.mode = 'protocol-timeout'; fixture.abortPrompt = undefined;
  await expect(executeWorker({ ...input, engine: 'dsh-acp', config: { ...config, timeoutMs: 100 } })).rejects.toThrow('Worker timeout');
  expect(fixture.commands.at(-1)).toContain('cancel');
  fixture.frames = []; fixture.commands = []; fixture.mode = 'cancel-unconfirmed';
  await expect(executeWorker({ ...input, engine: 'dsh-acp', config: { ...config, collectArtifacts: true } })).rejects.toThrow('DSH runtime cleanup');
  expect(fixture.commands.some(command => command.includes('export'))).toBe(false);
 });
 it('still attempts unit stop when wrapper exit cannot be verified', async () => {
  vi.useFakeTimers();
  try {
   fixture.frames = []; fixture.commands = []; fixture.mode = 'wrapper-stuck'; fixture.abortPrompt = undefined;
   const result = executeWorker({ ...input, engine: 'dsh-acp' });
   const rejected = expect(result).rejects.toThrow('DSH runtime cleanup');
   await vi.advanceTimersByTimeAsync(2600); await rejected;
   expect(fixture.commands.at(-1)).toContain('cancel');
  } finally { vi.useRealTimers(); }
 });
});
