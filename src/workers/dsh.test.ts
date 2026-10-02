import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const fixture = vi.hoisted(() => ({ frames: [] as any[], mode: 'success', child: undefined as any }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => {
 const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null as null | number, signalCode: null, kill: () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); return true; } }); fixture.child = child;
 const send = (frame: any) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
 child.stdin.on('data', raw => {
  const f = JSON.parse(raw.toString()); fixture.frames.push(f);
  queueMicrotask(() => {
   if (f.method === 'initialize') send({ id: f.id, result: f.params.provider ? { serverInfo: { name: 'deepseek-harness-sdk-runtime' } } : { protocolVersion: 1, agentInfo: { name: 'deepseek-harness-acp' } } });
   else if (f.method === 'session/new') send({ id: f.id, result: { sessionId: 'acp-session', configOptions: [{ id: 'model', options: [{ group: 'xworkmate', options: [{ value: '["xworkmate","test-model"]' }] }] }] } });
   else if (f.method === 'session/set_config_option' || f.method === 'session/close' || f.method === 'shutdown') send({ id: f.id, result: {} });
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
  fixture.frames = [];
  expect(await executeWorker({ ...input, engine: 'dsh-acp' })).toMatchObject({ text: 'acp-completed' });
  expect(fixture.frames.find(f => f.method === 'session/new').params.cwd).toContain('/dsh-acp/');
  expect(fixture.frames.find(f => f.method === 'session/set_config_option').params.value).toBe('["xworkmate","test-model"]');
  expect(fixture.frames.at(-1).method).toBe('session/close'); expect(fixture.child.exitCode).toBe(0);
 });
 it('SDK returns only after durable turn ending and agent idle', async () => {
  fixture.frames = [];
  expect(await executeWorker({ ...input, engine: 'dsh-sdk' })).toMatchObject({ text: 'sdk-completed' });
  expect(fixture.frames[0].params.provider).toBe('xworkmate');
  expect(fixture.frames.at(-1).method).toBe('shutdown'); expect(fixture.child.exitCode).toBe(0);
 });
});
