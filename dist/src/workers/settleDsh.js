import { spawn } from 'node:child_process';
/** Wrapper exit alone is insufficient: the root-owned launcher confirms cgroup
 * inactivity and prevents a late start of this exact run via its cancel marker.
 * Cleanup intentionally ignores the caller's already aborted signal.
 */
export async function settleDshUnit(input) {
    const [bin, ...args] = input.config.command;
    const raw = await new Promise((resolve, reject) => {
        const child = spawn(bin, [...args, 'cancel', input.engine, input.runId], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let bytes = 0;
        let failure;
        let killTimer;
        let exitTimer;
        const fail = (message) => {
            if (failure)
                return;
            failure = new Error(message);
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
            exitTimer = setTimeout(() => reject(new Error('DSH unit cleanup command exit unverified; runtime may remain active')), 2500);
        };
        // 65 seconds + bounded kill/reap grace stays below the 70 second contract.
        const timer = setTimeout(() => fail('DSH unit cleanup deadline exceeded; runtime may remain active'), 65000);
        child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > 32768)
            fail('DSH unit cleanup output bound exceeded');
        else
            chunks.push(chunk); });
        child.stderr.on('data', (chunk) => { bytes += chunk.length; if (bytes > 32768)
            fail('DSH unit cleanup output bound exceeded'); });
        child.on('error', () => fail('DSH unit cleanup command failed to launch'));
        child.on('close', code => {
            clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            if (exitTimer)
                clearTimeout(exitTimer);
            if (failure)
                reject(failure);
            else if (code !== 0)
                reject(new Error('DSH unit cleanup failed; runtime stop is unverified'));
            else
                resolve(Buffer.concat(chunks).toString('utf8'));
        });
    });
    let result;
    try {
        result = JSON.parse(raw);
    }
    catch {
        throw new Error('DSH unit cleanup returned malformed confirmation');
    }
    if (!result || result.profile !== input.engine || result.runId !== input.runId || result.workerStopped !== true)
        throw new Error('DSH unit cleanup did not confirm the owned runtime stopped');
}
