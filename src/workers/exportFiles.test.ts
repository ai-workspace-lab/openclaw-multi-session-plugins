import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { validateWorkerManifest } from './exportFiles.js';
const file = { relativePath: 'report.md', size: 2, contentBase64: 'aGk=', sha256: createHash('sha256').update('hi').digest('hex') };
const manifest = (artifacts: any[], runId = 'fixture') => JSON.stringify({ profile: 'dsh-acp', runId, artifacts });
describe('worker exported artifact contract', () => {
 it('accepts the launcher manifest with verified size and digest', () => expect(validateWorkerManifest(manifest([file]), 'dsh-acp', 'fixture')).toEqual([file]));
 it('rejects traversal and mismatched scope', () => {
  expect(() => validateWorkerManifest(manifest([{ ...file, relativePath: '../secret' }]), 'dsh-acp', 'fixture')).toThrow('path');
  expect(() => validateWorkerManifest(manifest([file], 'other'), 'dsh-acp', 'fixture')).toThrow('scope');
 });
 it('rejects damaged bytes, duplicate paths, and too many files', () => {
  expect(() => validateWorkerManifest(manifest([{ ...file, size: 3 }]), 'dsh-acp', 'fixture')).toThrow('integrity');
  expect(() => validateWorkerManifest(manifest([file, file]), 'dsh-acp', 'fixture')).toThrow('path');
  expect(() => validateWorkerManifest(manifest(Array(9).fill(file)), 'dsh-acp', 'fixture')).toThrow('scope');
 });
});
