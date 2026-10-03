import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/export_ownership_journal.dart';
import 'package:home_medicine_flutter/data/export_temporary_store.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';

class _ReviewFaultState implements PrivateAtomicState {
  _ReviewFaultState(this.delegate);
  final PrivateAtomicState delegate;
  bool rejectReadyCommit = false;
  bool loseReadyAcknowledgement = false;

  @override
  Future<String?> read() => delegate.read();

  @override
  Future<void> write(String value) async {
    final entries = (jsonDecode(value) as Map)['entries'] as List;
    final ready = entries.any((entry) => entry['readyStamp'] != null);
    if (ready && rejectReadyCommit) {
      throw const FileSystemException('synthetic rejected ready commit');
    }
    await delegate.write(value);
    if (ready && loseReadyAcknowledgement) {
      throw const FileSystemException('synthetic lost ready acknowledgement');
    }
  }
}

void main() {
  late Directory fixture;
  late Directory cache;
  late _ReviewFaultState state;
  late ExportProcessCoordinator process;

  ExportTemporaryStore store({
    Future<void> Function(File, List<int>)? writer,
  }) => ExportTemporaryStore(process: process, writeBytes: writer);

  Future<OwnedExportFile> create(ExportTemporaryStore files) => files.create(
    bytes: [1, 2, 3, 4],
    extension: 'md',
    identityEpoch: files.identityEpoch,
  );

  Future<List<ExportOwnershipRecord>> records() =>
      ExportOwnershipJournal(state: state).read();

  ExportProcessCoordinator restarted() => ExportProcessCoordinator(
    temporaryDirectory: () async => cache,
    journal: ExportOwnershipJournal(state: state),
  );

  setUp(() async {
    fixture = await Directory.systemTemp.createTemp('medbox-review-synthetic-');
    cache = await Directory('${fixture.path}/cache').create();
    final support = await Directory('${fixture.path}/support').create();
    state = _ReviewFaultState(
      FilePrivateAtomicState(
        directoryProvider: () async => support,
        name: 'export-ownership.v1.json',
      ),
    );
    process = ExportProcessCoordinator(
      temporaryDirectory: () async => cache,
      journal: ExportOwnershipJournal(state: state),
    );
  });

  tearDown(() async => fixture.delete(recursive: true));

  for (final throwsAfterWrite in [false, true]) {
    test(
      'live writer ${throwsAfterWrite ? 'failure' : 'success'} never adopts a replacement',
      () async {
        final entered = Completer<File>();
        final settle = Completer<void>();
        final files = store(
          writer: (file, bytes) async {
            await file.writeAsBytes(bytes, flush: true);
            entered.complete(file);
            await settle.future;
            if (throwsAfterWrite) {
              throw const FileSystemException('synthetic failed writer');
            }
          },
        );
        final pending = create(files);
        final rejection = expectLater(pending, throwsA(anything));
        final file = await entered.future;
        // Ensure a directory timestamp change is observable on this host. The
        // test never claims resistance to simultaneous metadata forgery.
        await Future<void>.delayed(const Duration(milliseconds: 20));
        await file.delete();
        await file.writeAsString('unregistered replacement');
        settle.complete();
        await rejection;
        expect(await file.exists(), true);
        expect(await file.readAsString(), 'unregistered replacement');
        expect(await records(), hasLength(1));
      },
    );
  }

  for (final substitution in ['regular file', 'symlink', 'missing file']) {
    test(
      'handoff refuses ready $substitution substitution before dispatch',
      () async {
        final files = store();
        final owned = await create(files);
        final external = await File('${fixture.path}/external.md')
            .writeAsString('unregistered external synthetic data');
        await owned.file.delete();
        if (substitution == 'regular file') {
          await owned.file.writeAsString('unregistered replacement');
        } else if (substitution == 'symlink') {
          await Link(owned.file.path).create(external.path);
        }
        var sent = false;
        await expectLater(
          files.handoff(
            owned,
            isCurrent: () => true,
            send: (_) async => sent = true,
          ),
          throwsA(isA<ExportTemporaryException>()),
        );
        expect(sent, false);
        expect(
          await external.readAsString(),
          'unregistered external synthetic data',
        );
        if (substitution == 'regular file') {
          expect(await owned.file.readAsString(), 'unregistered replacement');
        }
      },
    );
  }

  for (final persisted in [false, true]) {
    test(
      '${persisted ? 'lost acknowledgement after' : 'failure before'} ready commit cleans exact live original',
      () async {
        state.rejectReadyCommit = !persisted;
        state.loseReadyAcknowledgement = persisted;
        await expectLater(create(store()), throwsA(isA<FileSystemException>()));
        expect(await records(), isEmpty);
        expect(await cache.list().toList(), isEmpty);
      },
    );
  }

  test(
    'identity reset during handoff preflight prevents native dispatch',
    () async {
      final files = store();
      final owned = await create(files);
      var sent = false;
      final pending = files.handoff(
        owned,
        isCurrent: () => true,
        send: (_) async => sent = true,
      );
      final rejected = expectLater(pending, throwsA(anything));
      await files.resetForIdentity();
      await rejected;
      expect(sent, false);
      expect(await records(), isEmpty);
    },
  );

  test(
    'page cancellation during preflight is checked again before send',
    () async {
      final files = store();
      final owned = await create(files);
      var current = true;
      var sent = false;
      final pending = files.handoff(
        owned,
        isCurrent: () => current,
        send: (_) async => sent = true,
      );
      current = false;
      await expectLater(pending, throwsA(isA<ExportTemporaryException>()));
      expect(sent, false);
      await owned.release();
    },
  );

  test(
    'two simultaneous preflights cannot acquire overlapping native leases',
    () async {
      final first = store();
      final second = store();
      final firstFile = await create(first);
      final secondFile = await create(second);
      final entered = Completer<void>();
      final settle = Completer<void>();
      var sent = 0;
      Future<bool> attempt(
        ExportTemporaryStore files,
        OwnedExportFile owned,
      ) async {
        try {
          await files.handoff(
            owned,
            isCurrent: () => true,
            send: (_) async {
              sent++;
              if (!entered.isCompleted) entered.complete();
              await settle.future;
            },
          );
          return true;
        } on ExportTemporaryException {
          return false;
        }
      }

      final firstResult = attempt(first, firstFile);
      final secondResult = attempt(second, secondFile);
      await entered.future;
      try {
        expect(await Future.any([firstResult, secondResult]), false);
        expect(sent, 1);
      } finally {
        settle.complete();
        final results = await Future.wait([firstResult, secondResult]);
        expect(results.where((value) => value), hasLength(1));
        await firstFile.release();
        await secondFile.release();
      }
      expect(await records(), isEmpty);
    },
  );

  test(
    '64-entry limit blocks a 65th writer without losing registrations',
    () async {
      final files = store();
      final owned = <OwnedExportFile>[];
      for (var i = 0; i < ExportOwnershipJournal.maxEntries; i++) {
        owned.add(await create(files));
      }
      var wrote = false;
      await expectLater(
        create(store(writer: (_, _) async => wrote = true)),
        throwsA(isA<FormatException>()),
      );
      expect(wrote, false);
      expect(await records(), hasLength(64));
      expect(await cache.list().length, 64);
      await Future.wait(owned.map((file) => file.release()));
      expect(await records(), isEmpty);
      expect(await cache.list().toList(), isEmpty);
    },
  );

  for (final raw in [
    '{"version":2,"version":1,"entries":[]}',
    '{"version":1,"entries":[],"entries":[]}',
    '{ "version":1,"entries":[]}',
  ]) {
    test(
      'noncanonical or duplicate-key metadata remains untouched: $raw',
      () async {
        final memory = MemoryPrivateAtomicState(value: raw);
        final isolated = ExportTemporaryStore(
          process: ExportProcessCoordinator(
            temporaryDirectory: () async => cache,
            journal: ExportOwnershipJournal(state: memory),
          ),
        );
        await expectLater(
          create(isolated),
          throwsA(isA<ExportRecoveryException>()),
        );
        expect(memory.value, raw);
        expect(await cache.list().toList(), isEmpty);
      },
    );
  }

  test(
    'completed digest matches independent four-byte SHA-256 vector',
    () async {
      final owned = await create(store());
      expect(
        (await records()).single.readySha256,
        '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
      );
      await restarted().initialize();
      expect(await owned.file.exists(), false);
      expect(await records(), isEmpty);
    },
  );

  test('empty completed file has its own digest and is recoverable', () async {
    final files = store();
    final owned = await files.create(
      bytes: [],
      extension: 'md',
      identityEpoch: files.identityEpoch,
    );
    expect(
      (await records()).single.readySha256,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    await restarted().initialize();
    expect(await owned.file.exists(), false);
  });

  test(
    'multi-chunk export digest matches independently computed vector',
    () async {
      final files = store();
      final payload = List<int>.generate(
        1024 * 1024 + 7,
        (index) => index % 256,
      );
      final owned = await files.create(
        bytes: payload,
        extension: 'pdf',
        identityEpoch: files.identityEpoch,
      );
      expect(
        (await records()).single.readySha256,
        'd4efb848a0802763b512507ae58a4f52423febe5032ae0e4f8fbdbef361c3a32',
      );
      expect(await owned.file.length(), payload.length);
      var sent = false;
      await files.handoff(
        owned,
        isCurrent: () => true,
        send: (file) async {
          expect(await file.length(), payload.length);
          sent = true;
        },
      );
      expect(sent, true);
      expect(await owned.file.exists(), false);
      expect(await records(), isEmpty);
    },
  );

  for (final stampName in ['markerStamp', 'initialStamp']) {
    for (final operation in ['markReady', 'unregister']) {
      test(
        '$operation refuses altered immutable $stampName evidence',
        () async {
          final owned = await create(store());
          final original = (await records()).single;
          final map = jsonDecode((await state.read())!) as Map<String, dynamic>;
          map['entries'][0][stampName]['modified']++;
          await state.delegate.write(jsonEncode(map));
          final committed = await state.read();
          final journal = ExportOwnershipJournal(state: state);
          await expectLater(
            operation == 'markReady'
                ? journal.markReady(original)
                : journal.unregister(original),
            throwsA(isA<FormatException>()),
          );
          expect(await state.read(), committed);
          expect(await owned.file.readAsBytes(), [1, 2, 3, 4]);
        },
      );
    }
  }

  for (final output in <String, List<int>>{
    'truncated': [1, 2],
    'wrong same-size': [4, 3, 2, 1],
    'extra bytes': [1, 2, 3, 4, 5],
  }.entries) {
    test(
      'successful writer with ${output.key} payload never becomes shareable',
      () async {
        await expectLater(
          create(
            store(
              writer: (file, _) async {
                await file.writeAsBytes(output.value, flush: true);
              },
            ),
          ),
          throwsA(isA<ExportTemporaryException>()),
        );
        expect(await records(), isEmpty);
        expect(await cache.list().toList(), isEmpty);
      },
    );
  }

  test('digest mismatch independently prevents deletion when stat evidence matches', () async {
    final owned = await create(store());
    await owned.file.writeAsBytes([4, 3, 2, 1], flush: true);
    final map = jsonDecode((await state.read())!) as Map<String, dynamic>;
    // Align this synthetic committed stat with the altered file so this checks
    // the independent digest gate rather than only the metadata comparison.
    map['entries'][0]['readyStamp'] = ExportFileStamp.fromStat(
      await owned.file.stat(),
    ).toJson();
    await state.delegate.write(jsonEncode(map));
    final committed = await state.read();
    final recovery = restarted();
    await expectLater(
      recovery.initialize(),
      throwsA(isA<ExportRecoveryException>()),
    );
    expect(
      recovery.recoveryIssues.single.kind,
      ExportRecoveryIssueKind.ambiguousOwnership,
    );
    expect(await owned.file.readAsBytes(), [4, 3, 2, 1]);
    expect(await state.read(), committed);
  });

  for (final mutation in <String, void Function(Map<String, dynamic>)>{
    'missing hash field': (entry) => entry.remove('readySha256'),
    'null hash with ready stamp': (entry) => entry['readySha256'] = null,
    'hash without ready stamp': (entry) => entry['readyStamp'] = null,
    'uppercase hash': (entry) => entry['readySha256'] = 'A' * 64,
    'nonhex hash': (entry) => entry['readySha256'] = 'g' * 64,
    'short hash': (entry) => entry['readySha256'] = 'a' * 63,
    'wrong hash type': (entry) => entry['readySha256'] = 1,
    'nonempty allocation': (entry) => entry['initialStamp']['size'] = 1,
    'wrong marker allocation size': (entry) =>
        entry['markerStamp']['size'] = 31,
  }.entries) {
    test(
      'malformed ${mutation.key} is retained without recovery writes',
      () async {
        final owned = await create(store());
        final map = jsonDecode((await state.read())!) as Map<String, dynamic>;
        mutation.value(map['entries'][0] as Map<String, dynamic>);
        await state.delegate.write(jsonEncode(map));
        final committed = await state.read();
        final recovery = restarted();
        await expectLater(
          recovery.initialize(),
          throwsA(isA<ExportRecoveryException>()),
        );
        expect(
          recovery.recoveryIssues.single.kind,
          ExportRecoveryIssueKind.journalUnavailable,
        );
        expect(await owned.file.readAsBytes(), [1, 2, 3, 4]);
        expect(await state.read(), committed);
      },
    );
  }
}
