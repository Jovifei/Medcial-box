import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'support/symlink_capability.dart';
import 'package:home_medicine_flutter/data/export_ownership_journal.dart';
import 'package:home_medicine_flutter/data/export_temporary_store.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';

class FaultState implements PrivateAtomicState {
  FaultState(this.delegate);
  final PrivateAtomicState delegate;
  int reads = 0;
  int writes = 0;
  bool failRead = false;
  bool failWrite = false;
  bool persistThenThrow = false;
  Future<void> Function(String)? beforeWrite;
  @override
  Future<String?> read() async {
    reads++;
    if (failRead) {
      throw const FileSystemException('synthetic unreadable journal');
    }
    return delegate.read();
  }

  @override
  Future<void> write(String value) async {
    writes++;
    await beforeWrite?.call(value);
    if (failWrite) throw const FileSystemException('synthetic failed commit');
    await delegate.write(value);
    if (persistThenThrow) {
      throw const FileSystemException('synthetic lost acknowledgement');
    }
  }
}

void main() {
  late Directory fixture;
  late Directory root;
  late Directory support;
  late FaultState state;
  late ExportProcessCoordinator process;
  ExportOwnershipJournal journal() => ExportOwnershipJournal(state: state);
  ExportProcessCoordinator newProcess({
    Future<void> Function(File)? deleteFile,
  }) => ExportProcessCoordinator(
    temporaryDirectory: () async => root,
    journal: journal(),
    deleteFile: deleteFile,
  );
  ExportTemporaryStore store({
    ExportProcessCoordinator? coordinator,
    Future<void> Function(File, List<int>)? writer,
  }) =>
      ExportTemporaryStore(process: coordinator ?? process, writeBytes: writer);
  Future<OwnedExportFile> create(ExportTemporaryStore files, {int? epoch}) =>
      files.create(
        bytes: [1, 2, 3, 4],
        extension: 'md',
        identityEpoch: epoch ?? files.identityEpoch,
      );
  Future<List<dynamic>> entries() async =>
      ((jsonDecode((await state.read())!) as Map)['entries'] as List);
  Future<void> replaceMetadata(
    void Function(Map<String, dynamic>) mutate,
  ) async {
    final map = jsonDecode((await state.read())!) as Map<String, dynamic>;
    mutate(map);
    await state.delegate.write(jsonEncode(map));
  }

  setUp(() async {
    fixture = await Directory.systemTemp.createTemp(
      'medbox-restart-synthetic-',
    );
    root = await Directory('${fixture.path}/cache').create();
    support = await Directory('${fixture.path}/support').create();
    state = FaultState(
      FilePrivateAtomicState(
        directoryProvider: () async => support,
        name: 'export-ownership.v1.json',
      ),
    );
    process = newProcess();
  });
  tearDown(() async => fixture.delete(recursive: true));

  test(
    'new process recovers an original registered by previous process',
    () async {
      final owned = await create(store());
      expect(await owned.file.readAsBytes(), [1, 2, 3, 4]);
      await store(coordinator: newProcess()).initialize();
      expect(await owned.file.exists(), false);
      expect(await entries(), isEmpty);
    },
  );

  test('second store cannot overlap a live native handoff', () async {
    final first = store();
    final second = store();
    final firstFile = await create(first);
    final secondFile = await create(second);
    final entered = Completer<void>();
    final gate = Completer<void>();
    final pending = first.handoff(
      firstFile,
      isCurrent: () => true,
      send: (_) async {
        entered.complete();
        await gate.future;
      },
    );
    await entered.future;
    await second.initialize();
    expect(await firstFile.file.exists(), true);
    try {
      await expectLater(
        second.handoff(secondFile, isCurrent: () => true, send: (_) async {}),
        throwsA(isA<ExportTemporaryException>()),
      );
    } finally {
      gate.complete();
      await pending;
      await secondFile.release();
    }
  });

  test(
    'registration is durable before private bytes enter the writer',
    () async {
      final owned = await create(
        store(
          writer: (file, bytes) async {
            final registered = await entries();
            expect(registered, hasLength(1));
            expect(await file.length(), 0);
            expect(registered.single['readyStamp'], isNull);
            expect((await state.read())!, isNot(contains(file.path)));
            await file.writeAsBytes(bytes, flush: true);
          },
        ),
      );
      expect((await entries()).single['readyStamp'], isNotNull);
      await owned.release();
    },
  );

  test('failed register prevents private byte writes', () async {
    state.failWrite = true;
    var wrote = false;
    await expectLater(
      create(
        store(
          writer: (file, bytes) async {
            wrote = true;
          },
        ),
      ),
      throwsA(anything),
    );
    expect(wrote, false);
    expect(await root.list().toList(), isEmpty);
    state.failWrite = false;
    await store().resetForIdentity();
  });

  test(
    'acknowledgement lost after registration never enables private writes',
    () async {
      state.persistThenThrow = true;
      var wrote = false;
      await expectLater(
        create(
          store(
            writer: (file, bytes) async {
              wrote = true;
            },
          ),
        ),
        throwsA(anything),
      );
      expect(wrote, false);
      state.persistThenThrow = false;
      await newProcess().initialize();
      expect(await entries(), isEmpty);
    },
  );

  test(
    'process death before first byte recovers registered empty original',
    () async {
      final entered = Completer<File>();
      unawaited(
        create(
          store(
            writer: (file, bytes) async {
              entered.complete(file);
              await Completer<void>().future;
            },
          ),
        ),
      );
      final file = await entered.future;
      expect(await file.length(), 0);
      await newProcess().initialize();
      expect(await file.exists(), false);
      expect(await entries(), isEmpty);
    },
  );

  test(
    'process death during partial write retains ambiguous original',
    () async {
      final entered = Completer<File>();
      unawaited(
        create(
          store(
            writer: (file, bytes) async {
              await file.writeAsBytes(bytes.take(2).toList(), flush: true);
              entered.complete(file);
              await Completer<void>().future;
            },
          ),
        ),
      );
      final file = await entered.future;
      expect(
        await file.length(),
        2,
      ); // Synthetic partial content remains private and retained.
      await expectLater(
        newProcess().initialize(),
        throwsA(isA<ExportTemporaryException>()),
      );
      expect(await file.exists(), true);
      expect(await entries(), hasLength(1));
    },
  );

  test(
    'process death after complete write before ready commit retains ambiguity',
    () async {
      final entered = Completer<File>();
      unawaited(
        create(
          store(
            writer: (file, bytes) async {
              await file.writeAsBytes(bytes, flush: true);
              entered.complete(file);
              await Completer<void>().future;
            },
          ),
        ),
      );
      final file = await entered.future;
      expect(await file.length(), 4);
      await expectLater(
        newProcess().initialize(),
        throwsA(isA<ExportTemporaryException>()),
      );
      expect(await file.exists(), true);
    },
  );

  test(
    'second live store does not interpret interrupted writer as death',
    () async {
      final entered = Completer<File>();
      final gate = Completer<void>();
      final first = store(
        writer: (file, bytes) async {
          await file.writeAsBytes(bytes.take(2).toList(), flush: true);
          entered.complete(file);
          await gate.future;
          await file.writeAsBytes(bytes, flush: true);
        },
      );
      final pending = create(first);
      final file = await entered.future;
      await store().initialize();
      expect(await file.length(), 2);
      final next = await create(store());
      gate.complete();
      await (await pending).release();
      await next.release();
      expect(await entries(), isEmpty);
    },
  );

  test('identity reset through recreated store drains old write and invalidates it', () async {
    final entered = Completer<void>();
    final gate = Completer<void>();
    final pending = create(
      store(
        writer: (file, bytes) async {
          await file.writeAsBytes(bytes.take(2).toList());
          entered.complete();
          await gate.future;
          await file.writeAsBytes(bytes);
        },
      ),
    );
    final rejected = expectLater(
      pending,
      throwsA(isA<ExportTemporaryException>()),
    );
    await entered.future;
    final second = store();
    final cleanup = second.resetForIdentity();
    expect(second.identityEpoch, 1);
    gate.complete();
    await rejected;
    await cleanup;
    expect(await entries(), isEmpty);
    await (await create(second)).release();
  });

  test('old native lease survives service identity reset but new process releases it', () async {
    final first = store();
    final owned = await create(first);
    final entered = Completer<void>();
    final gate = Completer<void>();
    final pending = first.handoff(
      owned,
      isCurrent: () => true,
      send: (file) async {
        await file.readAsBytes();
        entered.complete();
        await gate.future;
      },
    );
    await entered.future;
    await store().resetForIdentity();
    expect(await owned.file.exists(), true);
    await newProcess().initialize();
    expect(await owned.file.exists(), false);
    gate.complete();
    await pending;
  });

  test(
    'failed deletion retains registration and new process retries',
    () async {
      var failing = true;
      process = newProcess(
        deleteFile: (file) async {
          if (failing) {
            throw const FileSystemException('synthetic failed delete');
          }
          await file.delete();
        },
      );
      final owned = await create(store());
      await expectLater(
        owned.release(),
        throwsA(isA<ExportTemporaryException>()),
      );
      expect(await entries(), hasLength(1));
      expect(await owned.file.exists(), true);
      failing = false;
      await owned.release();
      expect(await entries(), isEmpty);
    },
  );

  test(
    'failed unregister after actual deletion retries missing file idempotently',
    () async {
      final owned = await create(store());
      state.failWrite = true;
      await expectLater(
        owned.release(),
        throwsA(isA<ExportTemporaryException>()),
      );
      expect(await owned.file.exists(), false);
      expect(await entries(), hasLength(1));
      state.failWrite = false;
      await owned.release();
      await owned.release();
      expect(await entries(), isEmpty);
    },
  );

  test('missing original or entire directory is idempotent', () async {
    final first = await create(store());
    await first.file.delete();
    await first.release();
    final second = await create(store());
    await second.file.parent.delete(
      recursive: true,
    ); // Owned synthetic fixture only.
    await newProcess().initialize();
    expect(await entries(), isEmpty);
  });

  test(
    'unregistered siblings, plugin, legacy and imported files survive without links',
    () async {
      final external = await File('${fixture.path}/imported.json')
          .writeAsString('external');
      final plugin = await Directory('${root.path}/share_plus').create();
      final copy = await File('${plugin.path}/native-copy.md')
          .writeAsString('copy');
      final legacy = await File('${root.path}/medicine-inventory-old.md')
          .writeAsString('legacy');
      final owned = await create(store());
      final sibling = await File('${owned.file.parent.path}/unregistered.txt')
          .writeAsString('extra');
      await newProcess().initialize();
      expect(await owned.file.exists(), false);
      expect(await sibling.readAsString(), 'extra');
      expect(await external.readAsString(), 'external');
      expect(await copy.readAsString(), 'copy');
      expect(await legacy.readAsString(), 'legacy');
      expect(await entries(), isEmpty);
    },
  );

  test(
    'unexpected siblings, links, plugin, legacy and imported files survive',
    () async {
      if (!await requireSymbolicLinks()) return;
      final external = await File('${fixture.path}/imported.json')
          .writeAsString('external');
      final plugin = await Directory('${root.path}/share_plus').create();
      final copy = await File('${plugin.path}/native-copy.md')
          .writeAsString('copy');
      final legacy = await File('${root.path}/medicine-inventory-old.md')
          .writeAsString('legacy');
      final owned = await create(store());
      final sibling = await File('${owned.file.parent.path}/unregistered.txt')
          .writeAsString('extra');
      final link = await Link('${owned.file.parent.path}/unregistered-link')
          .create(external.path);
      await newProcess().initialize();
      expect(await owned.file.exists(), false);
      expect(await sibling.readAsString(), 'extra');
      expect(await link.target(), external.path);
      expect(await external.readAsString(), 'external');
      expect(await copy.readAsString(), 'copy');
      expect(await legacy.readAsString(), 'legacy');
      expect(await entries(), isEmpty);
    },
  );

  test(
    'regular file substitution is retained and recovery fails closed',
    () async {
      final owned = await create(store());
      await owned.file.delete();
      await owned.file.writeAsString('unregistered replacement');
      await expectLater(
        newProcess().initialize(),
        throwsA(isA<ExportTemporaryException>()),
      );
      expect(await owned.file.readAsString(), 'unregistered replacement');
      expect(await entries(), hasLength(1));
    },
  );

  test('partial-file substitution is retained without adopting it', () async {
    final entered = Completer<File>();
    unawaited(
      create(
        store(
          writer: (file, bytes) async {
            await file.writeAsBytes([1]);
            entered.complete(file);
            await Completer<void>().future;
          },
        ),
      ),
    );
    final file = await entered.future;
    await file.delete();
    await file.writeAsString('replacement');
    await expectLater(
      newProcess().initialize(),
      throwsA(isA<ExportTemporaryException>()),
    );
    expect(await file.readAsString(), 'replacement');
  });

  for (final kind in [
    'file-link',
    'file-directory',
    'directory-link',
    'marker-link',
    'marker-replacement',
  ]) {
    test(
      '$kind substitution is retained with external targets untouched',
      () async {
        if (kind.endsWith('-link') && !await requireSymbolicLinks()) return;
        final owned = await create(store());
        final external = await File('${fixture.path}/external.md')
            .writeAsString('external');
        final record = (await journal().read()).single;
        final marker = File('${owned.file.parent.path}/${record.marker}');
        switch (kind) {
          case 'file-link':
            await owned.file.delete();
            await Link(owned.file.path).create(external.path);
          case 'file-directory':
            await owned.file.delete();
            await Directory(owned.file.path).create();
          case 'directory-link':
            final original = owned.file.parent.path;
            await owned.file.parent.rename('$original-moved');
            await Link(original).create(fixture.path);
          case 'marker-link':
            await marker.delete();
            await Link(marker.path).create(external.path);
          case 'marker-replacement':
            await marker.delete();
            await marker.writeAsString(record.id);
        }
        await expectLater(
          newProcess().initialize(),
          throwsA(isA<ExportTemporaryException>()),
        );
        expect(await external.readAsString(), 'external');
        expect(await entries(), hasLength(1));
      },
    );
  }

  test('root link substitution never follows it', () async {
    if (!await requireSymbolicLinks()) return;
    final owned = await create(store());
    final original = root.path;
    await root.rename('$original-moved');
    await Link(original).create(fixture.path);
    await expectLater(
      owned.release(),
      throwsA(isA<ExportTemporaryException>()),
    );
    await expectLater(
      newProcess().initialize(),
      throwsA(isA<ExportTemporaryException>()),
    );
    expect(await entries(), hasLength(1));
  });

  for (final mutation in <String, void Function(Map<String, dynamic>)>{
    'absolute directory': (m) => m['entries'][0]['directory'] = '/tmp/unsafe',
    'traversal directory': (m) => m['entries'][0]['directory'] = '../unsafe',
    'backslash directory': (m) => m['entries'][0]['directory'] = r'..\unsafe',
    'traversal basename': (m) => m['entries'][0]['name'] = '../unsafe',
    'absolute basename': (m) => m['entries'][0]['name'] = '/tmp/unsafe',
    'unknown extension': (m) =>
        m['entries'][0]['name'] = 'medicine-inventory-${'a' * 32}.exe',
    'wrong id type': (m) => m['entries'][0]['id'] = 1,
    'wrong stamp type': (m) => m['entries'][0]['initialStamp']['size'] = '1',
    'negative stamp': (m) => m['entries'][0]['initialStamp']['size'] = -1,
    'floating version': (m) => m['version'] = 1.0,
    'unknown version': (m) => m['version'] = 2,
    'extra key': (m) => m['sharing'] = true,
    'duplicate records': (m) => m['entries'].add(m['entries'][0]),
    'non-list entries': (m) => m['entries'] = {},
    'overlong entries': (m) => m['entries'] = List.filled(65, m['entries'][0]),
  }.entries) {
    test(
      'malformed ${mutation.key} metadata blocks recovery and new writes',
      () async {
        final owned = await create(store());
        await replaceMetadata(mutation.value);
        final corrupted = await state.read();
        var wrote = false;
        await expectLater(
          create(
            store(
              coordinator: newProcess(),
              writer: (_, _) async {
                wrote = true;
              },
            ),
          ),
          throwsA(anything),
        );
        expect(wrote, false);
        expect(await owned.file.exists(), true);
        expect(await state.read(), corrupted);
      },
    );
  }

  for (final raw in [
    '',
    'not-json',
    '[]',
    '{"version":1,"entries":null}',
    'x' * 65537,
  ]) {
    test('corrupt journal (${raw.length} bytes) is never replaced', () async {
      // An injected reader permits testing an oversized source beyond the file adapter limit.
      final memory = MemoryPrivateAtomicState(value: raw);
      final isolated = ExportProcessCoordinator(
        temporaryDirectory: () async => root,
        journal: ExportOwnershipJournal(state: memory),
      );
      await expectLater(
        create(store(coordinator: isolated)),
        throwsA(anything),
      );
      expect(memory.value, raw);
      expect(await root.list().toList(), isEmpty);
    });
  }

  test('unreadable journal fails closed and explicit retry succeeds', () async {
    final owned = await create(store());
    final restarted = newProcess();
    state.failRead = true;
    await expectLater(restarted.initialize(), throwsA(anything));
    expect(await owned.file.exists(), true);
    state.failRead = false;
    await restarted.initialize();
    expect(await owned.file.exists(), false);
  });

  test(
    'repeated shares use fresh basenames and keep journal bounded',
    () async {
      final files = store();
      final names = <String>{};
      for (var i = 0; i < 12; i++) {
        final owned = await create(files);
        expect(names.add(owned.file.uri.pathSegments.last), true);
        final result = await files.handoff(
          owned,
          isCurrent: () => true,
          send: (file) async {
            expect(await file.readAsBytes(), [1, 2, 3, 4]);
            return 'selected';
          },
        );
        expect(result, 'selected');
        expect(await entries(), isEmpty);
      }
    },
  );

  test(
    'native result survives cleanup failure and remains retryable',
    () async {
      var failing = true;
      process = newProcess(
        deleteFile: (file) async {
          if (failing) {
            throw const FileSystemException('synthetic deletion failure');
          }
          await file.delete();
        },
      );
      final files = store();
      final owned = await create(files);
      expect(
        await files.handoff(
          owned,
          isCurrent: () => true,
          send: (_) async => 'cancelled',
        ),
        'cancelled',
      );
      expect(owned.cleanupError, isNotNull);
      expect(await entries(), hasLength(1));
      failing = false;
      await files.resetForIdentity();
      expect(owned.cleanupError, isNull);
      expect(await entries(), isEmpty);
    },
  );
  test(
    'failed ready commit cleans known live original without returning a file',
    () async {
      state.beforeWrite = (value) async {
        final records = jsonDecode(value)['entries'] as List;
        if (records.isNotEmpty && records.first['readyStamp'] != null) {
          throw const FileSystemException('synthetic ready commit failure');
        }
      };
      await expectLater(create(store()), throwsA(anything));
      expect(await root.list().toList(), isEmpty);
      expect(await entries(), isEmpty);
    },
  );

  test('page cancellation during share preflight never dispatches', () async {
    final files = store();
    final owned = await create(files);
    var current = true;
    var sent = false;
    final pending = files.handoff(
      owned,
      isCurrent: () => current,
      send: (_) async {
        sent = true;
      },
    );
    current = false;
    await expectLater(pending, throwsA(isA<ExportTemporaryException>()));
    expect(sent, false);
    await owned.release();
  });

  test('identity reset during share preflight never dispatches', () async {
    final files = store();
    final owned = await create(files);
    var sent = false;
    final pending = files.handoff(
      owned,
      isCurrent: () => true,
      send: (_) async {
        sent = true;
      },
    );
    final rejected = expectLater(
      pending,
      throwsA(isA<ExportTemporaryException>()),
    );
    await files.resetForIdentity();
    await rejected;
    expect(sent, false);
  });

  test('concurrent preflights still admit only one native lease', () async {
    final first = store();
    final second = store();
    final a = await create(first);
    final b = await create(second);
    final entered = Completer<void>();
    final gate = Completer<void>();
    var calls = 0;
    Future<void> send(File _) async {
      calls++;
      if (!entered.isCompleted) entered.complete();
      await gate.future;
    }

    final outcomes = <Object?>[];
    final p1 = first
        .handoff(a, isCurrent: () => true, send: send)
        .then<Object?>((_) => null, onError: (Object e) => e)
        .then(outcomes.add);
    final p2 = second
        .handoff(b, isCurrent: () => true, send: send)
        .then<Object?>((_) => null, onError: (Object e) => e)
        .then(outcomes.add);
    await entered.future;
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(calls, 1);
    gate.complete();
    await Future.wait([p1, p2]);
    expect(outcomes.whereType<ExportTemporaryException>(), hasLength(1));
    await a.release();
    await b.release();
  });

  test(
    'journal cap prevents new private bytes but permits existing cleanup',
    () async {
      final files = store();
      for (var i = 0; i < ExportOwnershipJournal.maxEntries; i++) {
        await create(files);
      }
      var wrote = false;
      await expectLater(
        create(
          store(
            writer: (_, _) async {
              wrote = true;
            },
          ),
        ),
        throwsA(anything),
      );
      expect(wrote, false);
      expect(await entries(), hasLength(ExportOwnershipJournal.maxEntries));
      await files.resetForIdentity();
      expect(await entries(), isEmpty);
      expect(await root.list().toList(), isEmpty);
    },
  );

  test(
    'ambiguous restart is typed and does not invalidate current identity',
    () async {
      final owned = await create(store());
      await owned.file.writeAsString('synthetic mutation');
      final restarted = newProcess();
      final files = store(coordinator: restarted);
      await expectLater(
        files.initialize(),
        throwsA(isA<ExportRecoveryException>()),
      );
      expect(
        files.recoveryIssues.single.kind,
        ExportRecoveryIssueKind.ambiguousOwnership,
      );
      expect(files.identityEpoch, 0);
      await files.resetForIdentity();
      expect(files.identityEpoch, 1);
      expect(await owned.file.readAsString(), 'synthetic mutation');
      await expectLater(create(files), throwsA(isA<ExportRecoveryException>()));
      expect(await entries(), hasLength(1));
    },
  );

  test(
    'duplicate raw JSON keys are rejected, never silently selected',
    () async {
      final owned = await create(store());
      final raw = (await state.read())!;
      await state.delegate.write(
        raw.replaceFirst('"version":1', '"version":0,"version":1'),
      );
      await expectLater(
        newProcess().initialize(),
        throwsA(isA<ExportRecoveryException>()),
      );
      expect(await owned.file.exists(), true);
    },
  );
}
