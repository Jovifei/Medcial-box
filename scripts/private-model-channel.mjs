import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { setInterval, clearInterval } from 'node:timers';

export async function acquireLocalLease(identity) {
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const name = process.platform === 'win32' ? `\\\\.\\pipe\\medbox-model-${key}` : `\0medbox-model-${key}`;
  const server = createServer((socket) => socket.destroy());
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(name, accept);
  });
  return server;
}

export async function stopChild(child, timeoutMs = 5000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((accept, reject) => {
    const exited = () => { clearTimeout(timer); accept(); };
    const timer = setTimeout(() => {
      child.removeListener('exit', exited);
      reject(new Error('OWNED_CHILD_DID_NOT_EXIT'));
    }, timeoutMs);
    child.once('exit', exited);
    child.kill();
  });
}

export async function shutdownOwned(forward, lease, timeoutMs) {
  await stopChild(forward, timeoutMs);
  if (lease?.pid && lease.exitCode === null && lease.signalCode === null && lease.stdin && !lease.stdin.destroyed) {
    // Give the remote lease its normal EOF path before terminating ssh locally.
    await new Promise((accept) => {
      const done = () => { clearTimeout(timer); accept(); };
      const timer = setTimeout(() => { lease.removeListener('exit', done); accept(); }, timeoutMs ?? 5000);
      lease.once('exit', done);
      lease.stdin.end();
    });
  }
  await stopChild(lease, timeoutMs);
}

export function sshArguments(host) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host)) throw new Error('INVALID_HOST_ALIAS');
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=no',
    '-o', 'StreamLocalBindMask=0177', '-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
}

export function validateSocket(path) {
  if (!/^\/[a-zA-Z0-9_./-]+\.sock$/.test(path) || path.includes('/../') || path.includes('//')) {
    throw new Error('INVALID_SOCKET_PATH');
  }
  return path;
}

async function run() {
  const { values } = parseArgs({ options: {
    host: { type: 'string' }, socket: { type: 'string' }, 'state-dir': { type: 'string' },
  } });
  const args = sshArguments(values.host ?? '');
  const socket = validateSocket(values.socket ?? '');
  if (!values['state-dir']) throw new Error('STATE_DIRECTORY_REQUIRED');
  const directory = resolve(values['state-dir']);
  await mkdir(directory, { recursive: true });
  const source = await readFile(new URL('./private_model_socket_lease.py', import.meta.url));
  const remote = `python3 -u -c 'exec(__import__("base64").b64decode("${source.toString('base64')}"))' '${socket}'`;
  const localLease = await acquireLocalLease(values.host + ':' + socket);
  let stop = false;
  let lease;
  let forward;
  let heartbeat;
  let generation = 0;
  let failures = 0;
  let lastState;
  const finish = () => { stop = true; };
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  const status = async (state, extra = {}) => {
    lastState = state;
    const record = { at: new Date().toISOString(), state, pid: process.pid, generation, sshPid: forward?.pid, ...extra };
    await writeFile(resolve(directory, 'status.json'), JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record));
  };
  const stopRequested = async () => {
    try {
      const request = JSON.parse(await readFile(resolve(directory, 'control.json'), 'utf8'));
      return request.pid === process.pid && request.action === 'stop';
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  try {
    while (!stop) {
      generation++;
      await status('CONNECTING');
      lease = spawn('ssh', [...args, values.host, remote], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
      let leaseFailed = false;
      let lastHeartbeat = Date.now();
      lease.stdin.on('error', () => { leaseFailed = true; });
      const lines = createInterface({ input: lease.stdout });
      lines.on('line', (line) => {
        if (line === '{"state": "LEASE_HEARTBEAT"}') lastHeartbeat = Date.now();
      });
      const ready = await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error('LEASE_TIMEOUT')), 30_000);
        const done = (value) => { clearTimeout(timer); accept(value); };
        lease.once('error', () => done({ state: 'TRANSPORT_ERROR' }));
        lease.once('exit', () => done({ state: 'TRANSPORT_ERROR' }));
        lines.once('line', (line) => {
          try { done(JSON.parse(line)); } catch { done({ state: 'INVALID_LEASE_RESPONSE' }); }
        });
      }).catch(() => ({ state: 'TRANSPORT_ERROR' }));
      if (ready.state === 'BLOCKED' || ready.state === 'INVALID_LEASE_RESPONSE') {
        await status('BLOCKED', { reason: ready.reason ?? ready.state });
        break; // Ownership uncertainty must not become an automatic retry loop.
      }
      if (ready.state === 'LEASE_READY' && !stop && lease.exitCode === null) {
        heartbeat = setInterval(() => {
          if (!lease.stdin.destroyed && !leaseFailed) lease.stdin.write('h\n');
        }, 10_000);
        const started = Date.now();
        forward = spawn('ssh', [...args, '-N', '-R', `${socket}:127.0.0.1:11434`, values.host],
          { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
        forward.on('error', (err) => { console.error('forward transport error:', err.message); });
        await status('FORWARD_STARTED_NOT_HEALTH_VERIFIED', { preserved: ready.preserved });
        while (!stop && forward.exitCode === null && forward.signalCode === null
            && lease.exitCode === null && lease.signalCode === null && !leaseFailed
            && Date.now() - lastHeartbeat < 35_000) {
          await delay(1000);
          if (await stopRequested()) stop = true;
        }
        if (Date.now() - started > 60_000) failures = 0;
      }
      await shutdownOwned(forward, lease);
      clearInterval(heartbeat);
      if (!stop) {
        failures++;
        if (failures >= 5) {
          await status('BLOCKED', { reason: 'TRANSPORT_FAILURE_LIMIT' });
          break;
        }
        // A killed local ssh may leave remote stdin alive until the 45s lease TTL.
        const retryMs = Math.min(60_000, Math.max(50_000, 5000 * 2 ** (failures - 1) + Math.random() * 1000));
        await status('RECONNECT_WAIT', { failures, retryMs });
        await delay(retryMs);
        if (await stopRequested()) stop = true;
      }
    }
  } finally {
    finish();
    try {
      await shutdownOwned(forward, lease);
      clearInterval(heartbeat);
      localLease.close();
      if (lastState !== 'BLOCKED') await status('STOPPED');
    } catch {
      // Keep local exclusion and heartbeat attempts; remote ownership becomes
      // unknown if the control connection fails, so no automatic takeover.
      await status('BLOCKED', { reason: 'OWNED_CHILD_DID_NOT_EXIT',
        remoteLease: 'HEARTBEAT_WHILE_CONNECTED_OTHERWISE_UNKNOWN' });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
