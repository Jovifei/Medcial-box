import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sshArguments, validateSocket, acquireLocalLease, shutdownOwned } from './private-model-channel.mjs';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers';

function child(name, order, exits = true) {
  const handle = new EventEmitter();
  Object.assign(handle, { pid: 123, exitCode: null, signalCode: null, kill() {
    order.push(name + ':kill');
    if (exits) setImmediate(() => {
      this.exitCode = 0;
      order.push(name + ':exit');
      this.emit('exit');
    });
  } });
  return handle;
}

test('shutdown proves forward exit before releasing remote lease', async () => {
  const order = [];
  await shutdownOwned(child('forward', order), child('lease', order));
  assert.deepEqual(order, ['forward:kill', 'forward:exit', 'lease:kill', 'lease:exit']);
});

test('unconfirmed forward exit preserves remote lease', async () => {
  const order = [];
  await assert.rejects(shutdownOwned(child('forward', order, false), child('lease', order), 20),
    /OWNED_CHILD_DID_NOT_EXIT/);
  assert.deepEqual(order, ['forward:kill']);
});

test('already exited or unstarted children do not block cleanup', async () => {
  const order = [];
  const closed = child('forward', order);
  closed.exitCode = 1;
  await shutdownOwned(closed, { pid: undefined });
  assert.deepEqual(order, []);
});

test('normal lease shutdown sends EOF after forward exit and avoids force killing lease', async () => {
  const order = [];
  const lease = child('lease', order);
  lease.stdin = { destroyed: false, end() {
    order.push('lease:eof');
    setImmediate(() => { lease.exitCode = 0; order.push('lease:exit'); lease.emit('exit'); });
  } };
  await shutdownOwned(child('forward', order), lease);
  assert.deepEqual(order, ['forward:kill', 'forward:exit', 'lease:eof', 'lease:exit']);
});

test('a second supervisor cannot acquire the same local channel lease', async () => {
  const key = 'synthetic-' + process.pid;
  const first = await acquireLocalLease(key);
  try { await assert.rejects(acquireLocalLease(key), { code: 'EADDRINUSE' }); }
  finally { await new Promise((accept) => first.close(accept)); }
});

test('forward preserves host checks, private socket permissions and disables unlink', () => {
  const args = sshArguments('existing-alias');
  for (const value of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'StreamLocalBindUnlink=no',
    'StreamLocalBindMask=0177', 'ExitOnForwardFailure=yes', 'ControlPath=none']) assert.ok(args.includes(value));
  assert.throws(() => sshArguments('-oUnsafe=yes'));
  assert.throws(() => sshArguments('host;command'));
  assert.equal(validateSocket('/private/model.sock'), '/private/model.sock');
  for (const path of ['/private/../model.sock', '/private//model.sock', 'relative.sock', "/private/a';x.sock"]) {
    assert.throws(() => validateSocket(path));
  }
});

test('Unix socket ownership, kernel listener, lease contention and stale preservation',
  { skip: process.platform === 'win32' ? 'Linux socket/flock tests run on Linux, including the existing host synthetic temporary directory' : false }, () => {
    const result = spawnSync('python3', [fileURLToPath(new URL('./test_private_model_socket_lease.py', import.meta.url))],
      { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
