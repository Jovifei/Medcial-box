import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'support/symlink_capability.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';

const _name = 'session-identity.v1.json';
const _child = 'medicine-private-state';
const _old = '{"version":1,"generation":"old","blocked":true}';
const _new = '{"version":1,"generation":"new","blocked":false}';

void main() {
  late Directory root;
  late File unrelated;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('private-atomic-state-test-');
    unrelated = await File('${root.path}/unrelated.txt').writeAsString('keep');
  });

  tearDown(() async {
    expect(await unrelated.readAsString(), 'keep');
    await root.delete(recursive: true); // Exact synthetic test fixture only.
  });

  FilePrivateAtomicState store({
    Directory? directory,
    String name = _name,
    Future<Directory> Function()? provider,
  }) => FilePrivateAtomicState(
    directoryProvider: provider ?? () async => directory ?? root,
    name: name,
  );

  File committed({String name = _name}) => File('${root.path}/$_child/$name');

  test('memory injection exposes synthetic state', () async {
    final memory = MemoryPrivateAtomicState(value: _old);
    expect(await memory.read(), _old);
    await memory.write(_new);
    expect(memory.value, _new);
    memory.value = null;
    expect(await memory.read(), isNull);
  });

  test(
    'missing state is read-only and a fresh instance reads a commit',
    () async {
      expect(await store().read(), isNull);
      expect(await Directory('${root.path}/$_child').exists(), isFalse);
      await store().write(_old);
      expect(await store().read(), _old);
      expect(await committed().readAsString(), _old);
      expect(
        await Directory('${root.path}/$_child')
            .list()
            .map((e) => e.absolute.uri.normalizePath())
            .toList(),
        [committed().absolute.uri.normalizePath()],
      );
    },
  );

  test(
    'writes are exclusive, flushed, closed, then renamed in one directory',
    () async {
      final probe = _IoProbe();
      await IOOverrides.runWithIOOverrides(() => store().write(_old), probe);
      expect(probe.events, [
        'create-exclusive',
        'write',
        'flush',
        'close',
        'rename',
      ]);
      expect(probe.temporaryPath, isNot(committed().path));
      expect(File(probe.temporaryPath!).parent.path, committed().parent.path);
      expect(probe.renameDestination, committed().path);
      expect(await store().read(), _old);
    },
  );

  for (final failure in [
    _Failure.partialWrite,
    _Failure.flush,
    _Failure.rename,
  ]) {
    test('failed $failure leaves old commit across fresh-instance restart', () async {
      await store().write(_old);
      final probe = _IoProbe(failure: failure);
      final writer = store();
      await IOOverrides.runWithIOOverrides(
        () => expectLater(
          writer.write(_new),
          throwsA(isA<FileSystemException>()),
        ),
        probe,
      );
      expect(await store().read(), _old);
      final orphan = File(probe.temporaryPath!);
      expect(await orphan.exists(), isTrue);
      final orphanBytes = await orphan.readAsBytes();
      expect(orphanBytes.length, lessThanOrEqualTo(utf8.encode(_new).length));
      if (failure == _Failure.partialWrite) {
        expect(orphanBytes, utf8.encode(_new).take(3).toList());
      }
      // Retrying uses another exclusive temp; a failed operation cannot poison
      // the queue. Never sweep a leftover, even when its contents look valid.
      await writer.write(_new);
      expect(await store().read(), _new);
      expect(await orphan.readAsBytes(), orphanBytes);
    });
  }

  test('a post-rename interruption can be read after restart', () async {
    await store().write(_old);
    final probe = _IoProbe(failure: _Failure.afterRename);
    await IOOverrides.runWithIOOverrides(
      () =>
          expectLater(store().write(_new), throwsA(isA<FileSystemException>())),
      probe,
    );
    // A thrown/unknown write result must not be taken as proof of no commit.
    expect(await store().read(), _new);
    expect(await File(probe.temporaryPath!).exists(), isFalse);
  });

  test(
    'first-write interruption never becomes committed by a new reader',
    () async {
      final probe = _IoProbe(failure: _Failure.partialWrite);
      await IOOverrides.runWithIOOverrides(
        () => expectLater(
          store().write(_new),
          throwsA(isA<FileSystemException>()),
        ),
        probe,
      );
      expect(await store().read(), isNull);
      expect(
        await File(probe.temporaryPath!).readAsBytes(),
        utf8.encode(_new).take(3),
      );
    },
  );

  test(
    'unlinked orphan temps and unrelated files are never read or swept',
    () async {
      final directory = await Directory('${root.path}/$_child').create();
      final good = await File('${directory.path}/.$_name.good.tmp')
          .writeAsString(_new);
      final partial = await File('${directory.path}/.$_name.partial.tmp')
          .writeAsString('{');
      final large = await File('${directory.path}/.$_name.large.tmp')
          .writeAsBytes(List.filled(FilePrivateAtomicState.maxBytes + 1, 97));
      final extra = await Directory('${directory.path}/unregistered').create();
      final extraFile = await File('${extra.path}/keep.txt')
          .writeAsString('preserve');
      expect(await store().read(), isNull);
      await store().write(_old);
      expect(await store().read(), _old);
      expect(await good.readAsString(), _new);
      expect(await partial.readAsString(), '{');
      expect(await large.length(), FilePrivateAtomicState.maxBytes + 1);
      expect(await extraFile.readAsString(), 'preserve');
    },
  );

  test('orphan valid, truncated, oversized and linked temps are never read or swept', () async {
    if (!await requireSymbolicLinks()) return;
    final directory = await Directory('${root.path}/$_child').create();
    final good = await File('${directory.path}/.$_name.good.tmp')
        .writeAsString(_new);
    final partial = await File('${directory.path}/.$_name.partial.tmp')
        .writeAsString('{');
    final large = await File('${directory.path}/.$_name.large.tmp')
        .writeAsBytes(List.filled(FilePrivateAtomicState.maxBytes + 1, 97));
    final linked = await Link('${directory.path}/.$_name.link.tmp')
        .create(unrelated.path);
    final extra = await Directory('${directory.path}/unregistered').create();
    final extraFile = await File('${extra.path}/keep.txt')
        .writeAsString('preserve');
    expect(await store().read(), isNull);
    await store().write(_old);
    expect(await store().read(), _old);
    expect(await good.readAsString(), _new);
    expect(await partial.readAsString(), '{');
    expect(await large.length(), FilePrivateAtomicState.maxBytes + 1);
    expect(await linked.target(), unrelated.path);
    expect(await extraFile.readAsString(), 'preserve');
  });

  test(
    'same instance preserves invocation order despite delayed provider',
    () async {
      final entered = Completer<void>();
      final release = Completer<void>();
      var calls = 0;
      final writer = store(
        provider: () async {
          calls++;
          if (calls == 1) {
            entered.complete();
            await release.future;
          }
          return root;
        },
      );
      final first = writer.write(_old);
      await entered.future;
      final second = writer.write(_new);
      final read = writer.read();
      await Future<void>.delayed(Duration.zero);
      expect(calls, 1);
      release.complete();
      await Future.wait([first, second]);
      expect(await read, _new);
    },
  );

  test('separate instances serialize while a file commit is paused', () async {
    final entered = Completer<void>();
    final release = Completer<void>();
    final probe = _IoProbe(
      beforeFirstFlush: () async {
        entered.complete();
        await release.future;
      },
    );
    await IOOverrides.runWithIOOverrides(() async {
      final first = store().write(_old);
      await entered.future;
      var secondFinished = false;
      final second = store().write(_new).then((_) => secondFinished = true);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(secondFinished, isFalse);
      expect(probe.events.where((e) => e == 'create-exclusive').length, 1);
      release.complete();
      await Future.wait([first, second]);
    }, probe);
    expect(await store().read(), _new);
  });

  test(
    'read queued during write sees only the newly committed whole value',
    () async {
      await store().write(_old);
      final entered = Completer<void>();
      final release = Completer<void>();
      final probe = _IoProbe(
        beforeFirstFlush: () async {
          entered.complete();
          await release.future;
        },
      );
      await IOOverrides.runWithIOOverrides(() async {
        final writing = store().write(_new);
        await entered.future;
        var readFinished = false;
        final reading = store().read().then((value) {
          readFinished = true;
          return value;
        });
        await Future<void>.delayed(const Duration(milliseconds: 20));
        expect(readFinished, isFalse);
        expect(await committed().readAsString(), _old);
        release.complete();
        await writing;
        expect(await reading, _new);
      }, probe);
    },
  );

  test('read errors propagate and do not poison the queue', () async {
    await store().write(_old);
    final reader = store();
    await IOOverrides.runWithIOOverrides(
      () => expectLater(reader.read(), throwsA(isA<FileSystemException>())),
      _IoProbe(failure: _Failure.read),
    );
    expect(await reader.read(), _old);
  });

  test(
    'corrupt UTF-8 throws; empty and invalid schema remain visible to caller',
    () async {
      await store().write(_old);
      await committed().writeAsBytes([0xc3, 0x28]);
      await expectLater(store().read(), throwsFormatException);
      await committed().writeAsString('');
      expect(await store().read(), '');
      await committed().writeAsString('{partial');
      expect(await store().read(), '{partial');
    },
  );

  test(
    'size bound counts UTF-8 bytes and preserves prior commit on rejection',
    () async {
      final writer = store();
      await writer.write(_old);
      for (final tooLarge in [
        'a' * (FilePrivateAtomicState.maxBytes + 1),
        '药' * (FilePrivateAtomicState.maxBytes ~/ 3 + 1),
        String.fromCharCode(0xd800),
      ]) {
        await expectLater(writer.write(tooLarge), throwsArgumentError);
        expect(await store().read(), _old);
      }
      final atLimit = 'a' * FilePrivateAtomicState.maxBytes;
      await writer.write(atLimit);
      expect(await store().read(), atLimit);
      await committed().writeAsBytes(
        List.filled(FilePrivateAtomicState.maxBytes + 1, 97),
      );
      await expectLater(store().read(), throwsA(isA<FileSystemException>()));
    },
  );

  test('unsafe names are rejected before any provider access', () async {
    var providerCalled = false;
    for (final name in [
      '',
      '.',
      '..',
      '../x',
      '/x',
      'a/b',
      r'a\b',
      'a\x00b',
      'a:b',
      'a.',
      '.hidden',
      'a..b',
      'CON',
      'nul.json',
      'x' * 97,
    ]) {
      expect(
        () => store(
          name: name,
          provider: () async {
            providerCalled = true;
            return root;
          },
        ),
        throwsArgumentError,
      );
    }
    expect(providerCalled, isFalse);
  });

  test('safe named states are independent', () async {
    await store().write(_old);
    await store(name: 'another-state.v1.json').write(_new);
    expect(await store().read(), _old);
    expect(await store(name: 'another-state.v1.json').read(), _new);
  });

  test(
    'relative and traversal provider paths fail before IO changes',
    () async {
      for (final path in [
        'relative',
        '${root.path}/../${root.uri.pathSegments.last}',
        '${root.path}/.',
      ]) {
        final files = store(directory: Directory(path));
        await expectLater(files.read(), throwsA(isA<FileSystemException>()));
        await expectLater(
          files.write(_new),
          throwsA(isA<FileSystemException>()),
        );
      }
      expect(await Directory('${root.path}/$_child').exists(), isFalse);
    },
  );

  test(
    'missing and non-directory support roots fail closed without symlinks',
    () async {
      for (final path in ['${root.path}/missing', unrelated.path]) {
        final files = store(directory: Directory(path));
        await expectLater(files.read(), throwsA(isA<FileSystemException>()));
        await expectLater(files.write(_new), throwsA(isA<FileSystemException>()));
      }
      expect(await Directory('${root.path}/missing').exists(), isFalse);
      expect(await unrelated.readAsString(), 'keep');
    },
  );

  test('missing, linked and non-directory support roots fail closed', () async {
    if (!await requireSymbolicLinks()) return;
    final link = await Link('${root.path}/support-link').create(root.path);
    for (final path in ['${root.path}/missing', link.path, unrelated.path]) {
      final files = store(directory: Directory(path));
      await expectLater(files.read(), throwsA(isA<FileSystemException>()));
      await expectLater(files.write(_new), throwsA(isA<FileSystemException>()));
    }
    expect(await link.target(), root.path);
    expect(await Directory('${root.path}/missing').exists(), isFalse);
  });

  for (final linked in [false, true]) {
    test(
      'a ${linked ? 'linked' : 'file'} private directory is untouched',
      () async {
        if (linked && !await requireSymbolicLinks()) return;
        final path = '${root.path}/$_child';
        if (linked) {
          await Link(path).create(root.path);
        } else {
          await File(path).writeAsString('preserve');
        }
        await expectLater(store().read(), throwsA(isA<FileSystemException>()));
        await expectLater(
          store().write(_new),
          throwsA(isA<FileSystemException>()),
        );
        if (linked) {
          expect(await Link(path).target(), root.path);
        } else {
          expect(await File(path).readAsString(), 'preserve');
        }
      },
    );
  }

  test('linked committed path is neither followed nor replaced', () async {
    if (!await requireSymbolicLinks()) return;
    await Directory('${root.path}/$_child').create();
    final link = await Link(committed().path).create(unrelated.path);
    await expectLater(store().read(), throwsA(isA<FileSystemException>()));
    await expectLater(store().write(_new), throwsA(isA<FileSystemException>()));
    expect(await link.target(), unrelated.path);
  });

  test(
    'dangling committed symlink is not mistaken for missing state',
    () async {
      if (!await requireSymbolicLinks()) return;
      await Directory('${root.path}/$_child').create();
      final target = '${root.path}/missing-link-target';
      final link = await Link(committed().path).create(target);
      await expectLater(store().read(), throwsA(isA<FileSystemException>()));
      await expectLater(
        store().write(_new),
        throwsA(isA<FileSystemException>()),
      );
      expect(await link.target(), target);
      expect(await File(target).exists(), isFalse);
    },
  );

  test(
    'directory at committed name is preserved without recursive deletion',
    () async {
      await Directory(committed().path).create(recursive: true);
      final child = await File('${committed().path}/owned-elsewhere')
          .writeAsString('keep');
      await expectLater(store().read(), throwsA(isA<FileSystemException>()));
      await expectLater(
        store().write(_new),
        throwsA(isA<FileSystemException>()),
      );
      expect(await child.readAsString(), 'keep');
    },
  );
}

enum _Failure { partialWrite, flush, rename, afterRename, read }

/// Injects failures into real, isolated fixture IO. This does not replace the
/// implementation under test or require production-only test hooks.
final class _IoProbe extends IOOverrides {
  _IoProbe({this.failure, this.beforeFirstFlush});

  final _Failure? failure;
  final Future<void> Function()? beforeFirstFlush;
  final List<String> events = [];
  String? temporaryPath;
  String? renameDestination;
  bool _flushed = false;

  @override
  File createFile(String path) => _ProbedFile(super.createFile(path), this);
}

class _ProbedFile implements File {
  _ProbedFile(this.delegate, this.probe);
  final File delegate;
  final _IoProbe probe;
  bool get temporary => path.endsWith('.tmp');

  @override
  String get path => delegate.path;

  @override
  Future<File> create({bool recursive = false, bool exclusive = false}) async {
    if (temporary) {
      probe.events.add(
        exclusive && !recursive ? 'create-exclusive' : 'unsafe-create',
      );
      probe.temporaryPath = path;
    }
    await delegate.create(recursive: recursive, exclusive: exclusive);
    return this;
  }

  @override
  Future<RandomAccessFile> open({FileMode mode = FileMode.read}) async =>
      _ProbedHandle(await delegate.open(mode: mode), probe, temporary);

  @override
  Future<File> rename(String newPath) async {
    probe.events.add('rename');
    probe.renameDestination = newPath;
    if (probe.failure == _Failure.rename) {
      throw const FileSystemException('Synthetic rename failure.');
    }
    final result = await delegate.rename(newPath);
    if (probe.failure == _Failure.afterRename) {
      throw const FileSystemException('Synthetic interruption after commit.');
    }
    return result;
  }

  @override
  Future<String> readAsString({Encoding encoding = utf8}) =>
      delegate.readAsString(encoding: encoding);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _ProbedHandle implements RandomAccessFile {
  _ProbedHandle(this.delegate, this.probe, this.temporary);
  final RandomAccessFile delegate;
  final _IoProbe probe;
  final bool temporary;

  @override
  Future<RandomAccessFile> writeFrom(
    List<int> buffer, [
    int start = 0,
    int? end,
  ]) async {
    probe.events.add('write');
    if (probe.failure == _Failure.partialWrite) {
      await delegate.writeFrom(buffer, start, start + 3);
      throw const FileSystemException('Synthetic interrupted partial write.');
    }
    await delegate.writeFrom(buffer, start, end);
    return this;
  }

  @override
  Future<RandomAccessFile> flush() async {
    probe.events.add('flush');
    if (!probe._flushed) {
      probe._flushed = true;
      await probe.beforeFirstFlush?.call();
    }
    if (probe.failure == _Failure.flush) {
      throw const FileSystemException('Synthetic flush failure.');
    }
    await delegate.flush();
    return this;
  }

  @override
  Future<int> length() => delegate.length();

  @override
  Future<Uint8List> read(int count) async {
    if (probe.failure == _Failure.read) {
      throw const FileSystemException('Synthetic read failure.');
    }
    return delegate.read(count);
  }

  @override
  Future<void> close() {
    if (temporary) probe.events.add('close');
    return delegate.close();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
