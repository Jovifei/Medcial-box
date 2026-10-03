// Explicit subprocess fixture; not part of automatic *_test.dart discovery.
// The owning runner creates and later removes the synthetic directory. Invoke
// separate Flutter test processes with MEDBOX_EXPORT_FIXTURE and PHASE defines.
import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/export_ownership_journal.dart';
import 'package:home_medicine_flutter/data/export_temporary_store.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';

void main() {
  test('independent process ownership boundary', () async {
    const path = String.fromEnvironment('MEDBOX_EXPORT_FIXTURE');
    const phase = String.fromEnvironment('MEDBOX_EXPORT_PHASE');
    if (path.isEmpty || !path.contains('/medbox-export-process-synthetic-')) {
      throw StateError(
        'This driver requires its own synthetic runner fixture.',
      );
    }
    final fixture = Directory(path);
    expect(
      await File('$path/synthetic-fixture').readAsString(),
      'synthetic-only',
    );
    final cache = Directory('$path/cache');
    final support = Directory('$path/support');
    await cache.create();
    await support.create();
    final journal = ExportOwnershipJournal(
      state: FilePrivateAtomicState(
        directoryProvider: () async => support,
        name: 'export-ownership.v1.json',
      ),
    );
    final process = ExportProcessCoordinator(
      temporaryDirectory: () async => cache,
      journal: journal,
    );
    final files = ExportTemporaryStore(process: process);
    switch (phase) {
      case 'seed-ready':
        await files.create(bytes: [7, 8, 9], extension: 'md', identityEpoch: 0);
        expect(await journal.read(), hasLength(1));
      case 'seed-partial':
        final entered = Completer<void>();
        final writer = ExportTemporaryStore(
          process: process,
          writeBytes: (file, bytes) async {
            await file.writeAsBytes([7], flush: true);
            entered.complete();
            await Completer<void>().future;
          },
        );
        unawaited(
          writer.create(bytes: [7, 8, 9], extension: 'md', identityEpoch: 0),
        );
        await entered.future;
        expect((await journal.read()).single.readyStamp, isNull);
      case 'seed-handoff':
        final owned = await files.create(
          bytes: [7, 8, 9],
          extension: 'md',
          identityEpoch: 0,
        );
        final entered = Completer<void>();
        unawaited(
          files.handoff(
            owned,
            isCurrent: () => true,
            send: (file) async {
              expect(await file.readAsBytes(), [7, 8, 9]);
              entered.complete();
              await Completer<void>().future;
            },
          ),
        );
        await entered.future;
      case 'recover-ready':
        final record = (await journal.read()).single;
        final original = File(
          '${cache.path}/${record.directory}/${record.name}',
        );
        expect(await original.exists(), true);
        await files.initialize();
        expect(await original.exists(), false);
        expect(await journal.read(), isEmpty);
      case 'retain-partial':
        final record = (await journal.read()).single;
        final original = File(
          '${cache.path}/${record.directory}/${record.name}',
        );
        await expectLater(
          files.initialize(),
          throwsA(isA<ExportTemporaryException>()),
        );
        expect(await original.readAsBytes(), [7]);
        expect(await journal.read(), hasLength(1));
      default:
        throw StateError('Unknown synthetic fixture phase.');
    }
    expect(await fixture.exists(), true);
  });
}
