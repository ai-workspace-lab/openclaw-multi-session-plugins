import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { openCodeFiles } from './opencodeFiles.js';
describe('real OpenCode v2 artifact shapes', () => {
 it('copies upstream FileDiff.patch exactly and logs actual shell content', () => {
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const files = openCodeFiles([{ file: 'a.ts', patch, status: 'modified', additions: 1, deletions: 1 }], [{ type: 'assistant', content: [{ type: 'tool', name: 'shell', executed: true, state: { status: 'completed', input: { command: 'npm test' }, content: [{ type: 'text', text: '2 tests passed' }], metadata: { exit: 0 } } }] }], 1048576);
  expect(Buffer.from(files[0].contentBase64, 'base64').toString()).toBe(patch);
  expect(files[0].sha256).toBe(createHash('sha256').update(patch).digest('hex'));
  const log = Buffer.from(files[1].contentBase64, 'base64').toString(); expect(log).toContain('executed=true'); expect(log).toContain('npm test'); expect(log).toContain('2 tests passed');
 });
 it('does not fabricate a diff or claim tests were run', () => {
  const files = openCodeFiles([], [{ type: 'assistant', content: [] }], 1048576);
  expect(files.map(f => f.relativePath)).toEqual(['tests.log']);
  expect(Buffer.from(files[0].contentBase64, 'base64').toString()).toContain('not verified');
 });
 it('keeps denied/error tool evidence and rejects malformed diffs', () => {
  const files = openCodeFiles([], [{ type: 'assistant', content: [{ type: 'tool', name: 'shell', executed: false, state: { status: 'error', input: { command: 'npm test' }, error: { message: 'Permission denied' } } }] }], 1048576);
  expect(Buffer.from(files[0].contentBase64, 'base64').toString()).toContain('executed=false');
  expect(() => openCodeFiles([{ file: 'a.ts', before: 'old', after: 'new' }], [], 1048576)).toThrow('diff');
 });
});
