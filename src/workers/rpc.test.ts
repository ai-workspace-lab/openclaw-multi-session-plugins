import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { WorkerRpc } from './executeWorker.js';
function fixture(limit = 2048, timeout = 1000) {
 const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, kill: () => true });
 const peer = new WorkerRpc(child as unknown as ChildProcessWithoutNullStreams, timeout, limit);
 const written: any[] = []; child.stdin.on('data', b => written.push(JSON.parse(b.toString())));
 return { peer, child, written };
}
describe('pinned worker NDJSON transport fixtures', () => {
 it('accepts split and coalesced frames and denies permission once', async () => {
  const { peer, child, written } = fixture();
  const result = peer.request('initialize', { protocolVersion: 1 });
  child.stdout.write('{"jsonrpc":"2.0","id":1,"res');
  child.stdout.write('ult":{"protocolVersion":1}}\n{"jsonrpc":"2.0","id":8,"method":"session/request_permission","params":{"options":[{"optionId":"deny-fixture","kind":"reject_once"}]}}\n');
  expect(await result).toEqual({ protocolVersion: 1 });
  expect(written.at(-1).result.outcome.optionId).toBe('deny-fixture'); peer.close();
 });
 it('rejects malformed stdout and does not reveal raw payload', async () => {
  const { peer, child } = fixture(); const result = peer.request('initialize');
  child.stdout.write('secret-nonprotocol-banner\n');
  await expect(result).rejects.toThrow('Malformed worker JSON-RPC'); peer.close();
 });
 it('bounds total output and rejects unanswered requests at deadline', async () => {
  const first = fixture(32); const result = first.peer.request('initialize'); first.child.stdout.write('x'.repeat(33));
  await expect(result).rejects.toThrow('output bound'); first.peer.close();
  const second = fixture(2048, 10); await expect(second.peer.request('initialize')).rejects.toThrow('timeout'); second.peer.close();
 });
});
