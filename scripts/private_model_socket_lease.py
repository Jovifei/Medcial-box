"""Hold an SSH-session lease; preserve only a proven stale owned Unix socket.

Python 3.6 compatible for the existing host. No API, database or Docker actions.
"""
import errno
import ctypes
import fcntl
import json
import os
import socket
import select
import stat
import sys
import time
import uuid


def identity(info):
    return (info.st_dev, info.st_ino, info.st_ctime_ns)


def rename_preserving(source, destination):
    # Linux RENAME_NOREPLACE: even an unexpected archive collision cannot overwrite.
    rename = getattr(ctypes.CDLL(None, use_errno=True), 'renameat2', None)
    if rename is None:
        raise RuntimeError('SAFE_RENAME_UNAVAILABLE')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def prepare(path, kernel_paths=None):
    directory = os.path.dirname(path)
    info = os.lstat(directory)
    if (not stat.S_ISDIR(info.st_mode) or os.path.realpath(directory) != directory
            or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise RuntimeError('UNSAFE_DIRECTORY')
    lock = os.open(path + '.lease', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        locked = os.fstat(lock)
        if (not stat.S_ISREG(locked.st_mode) or locked.st_uid != os.geteuid()
                or stat.S_IMODE(locked.st_mode) != 0o600 or locked.st_nlink != 1):
            raise RuntimeError('UNSAFE_LEASE')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not os.path.lexists(path):
            return lock, None
        before = os.lstat(path)
        if (not stat.S_ISSOCK(before.st_mode) or before.st_uid != os.geteuid()
                or before.st_gid != os.getegid() or stat.S_IMODE(before.st_mode) != 0o600):
            raise RuntimeError('UNSAFE_SOCKET')
        for attempt in range(2):
            if attempt:
                time.sleep(1)
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            probe.settimeout(2)
            try:
                probe.connect(path)
            except OSError as error:
                if error.errno != errno.ECONNREFUSED:
                    raise RuntimeError('SOCKET_STATE_UNKNOWN')
            else:
                raise RuntimeError('SOCKET_ACTIVE')
            finally:
                probe.close()
            paths = kernel_paths
            if paths is None:
                with open('/proc/net/unix') as handle:
                    paths = [line.split()[-1] for line in handle if len(line.split()) >= 8]
            if path in paths:
                raise RuntimeError('SOCKET_ACTIVE')
        if identity(os.lstat(path)) != identity(before):
            raise RuntimeError('SOCKET_CHANGED')
        backup = path + '.stale-' + uuid.uuid4().hex
        rename_preserving(path, backup)
        return lock, os.path.basename(backup)
    except BaseException:
        os.close(lock)
        raise


def main():
    path = sys.argv[1]
    if not os.path.isabs(path) or os.path.normpath(path) != path or not path.endswith('.sock'):
        raise RuntimeError('INVALID_SOCKET_PATH')
    lock, backup = prepare(path)
    try:
        print(json.dumps({'state': 'LEASE_READY', 'preserved': backup}), flush=True)
        # Bound lease lifetime even if sshd keeps an abandoned stdin open.
        while select.select([sys.stdin], [], [], 45)[0]:
            if not os.read(sys.stdin.fileno(), 4096):
                break
            print(json.dumps({'state': 'LEASE_HEARTBEAT'}), flush=True)
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'state': 'BLOCKED', 'reason': str(error) if isinstance(error, RuntimeError)
                          else type(error).__name__}), flush=True)
        sys.exit(23)
