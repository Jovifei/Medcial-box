import os
import socket
import tempfile
import unittest
from unittest.mock import patch

from private_model_socket_lease import prepare, rename_preserving, main


class SocketLeaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='medbox-socket-test-')
        os.chmod(self.directory.name, 0o700)
        self.path = os.path.join(self.directory.name, 'model.sock')
        self.locks = []

    def tearDown(self):
        for descriptor in self.locks:
            os.close(descriptor)
        self.directory.cleanup()

    def acquire(self, **kwargs):
        descriptor, backup = prepare(self.path, **kwargs)
        self.locks.append(descriptor)
        return backup

    def bound(self, listen=False):
        handle = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        handle.bind(self.path)
        os.chmod(self.path, 0o600)
        if listen:
            handle.listen(1)
        return handle

    def test_missing_path_and_exclusive_lock(self):
        self.assertIsNone(self.acquire())
        with self.assertRaises(BlockingIOError):
            self.acquire()

    def test_stale_socket_is_preserved_with_identical_inode(self):
        self.bound().close()
        inode = os.lstat(self.path).st_ino
        backup = self.acquire()
        self.assertFalse(os.path.lexists(self.path))
        self.assertEqual(inode, os.lstat(os.path.join(self.directory.name, backup)).st_ino)

    def test_live_listener_unchanged(self):
        handle = self.bound(listen=True)
        try:
            inode = os.lstat(self.path).st_ino
            with self.assertRaisesRegex(RuntimeError, 'SOCKET_ACTIVE'):
                self.acquire()
            self.assertEqual(inode, os.lstat(self.path).st_ino)
        finally:
            handle.close()

    def test_bound_but_not_listening_is_also_active(self):
        handle = self.bound()
        try:
            with self.assertRaisesRegex(RuntimeError, 'SOCKET_ACTIVE'):
                self.acquire()
        finally:
            handle.close()

    def test_regular_file_and_symlink_unchanged(self):
        with open(self.path, 'w') as handle:
            handle.write('synthetic')
        with self.assertRaisesRegex(RuntimeError, 'UNSAFE_SOCKET'):
            self.acquire()
        target = self.path + '.retained'
        os.rename(self.path, target)
        os.symlink(target, self.path)
        with self.assertRaisesRegex(RuntimeError, 'UNSAFE_SOCKET'):
            self.acquire()
        with open(target) as handle:
            self.assertEqual('synthetic', handle.read())

    def test_unsafe_permissions_refused(self):
        os.chmod(self.directory.name, 0o755)
        with self.assertRaisesRegex(RuntimeError, 'UNSAFE_DIRECTORY'):
            self.acquire()

    def test_archive_collision_never_overwrites_either_file(self):
        self.bound().close()
        destination = self.path + '.archive'
        with open(destination, 'w') as handle:
            handle.write('keep')
        with self.assertRaises(FileExistsError):
            rename_preserving(self.path, destination)
        self.assertTrue(os.path.lexists(self.path))
        with open(destination) as handle:
            self.assertEqual('keep', handle.read())

    def test_heartbeat_timeout_releases_abandoned_lease(self):
        with patch('sys.argv', ['lease', self.path]), patch('select.select', return_value=([], [], [])):
            main()
        self.assertIsNone(self.acquire())

    def test_stdin_eof_releases_lease(self):
        with patch('sys.argv', ['lease', self.path]), patch('select.select', return_value=([0], [], [])), \
                patch('sys.stdin.fileno', return_value=0), patch('os.read', return_value=b''):
            main()
        self.assertIsNone(self.acquire())

    def test_changed_inode_refused(self):
        self.bound().close()
        actual = os.lstat
        calls = [0]

        def changing(path):
            if path == self.path:
                calls[0] += 1
                if calls[0] == 3:  # lexists, initial metadata, final metadata
                    os.rename(self.path, self.path + '.original')
                    self.bound().close()
            return actual(path)

        with patch('os.lstat', side_effect=changing):
            with self.assertRaisesRegex(RuntimeError, 'SOCKET_CHANGED'):
                self.acquire(kernel_paths=[])
        self.assertTrue(os.path.lexists(self.path + '.original'))


if __name__ == '__main__':
    unittest.main()
