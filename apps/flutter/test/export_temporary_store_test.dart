import 'package:home_medicine_flutter/data/export_ownership_journal.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';

import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/export_temporary_store.dart';

void main() {
  late Directory root;
  late File sibling;
  setUp(() async {
    root = await Directory.systemTemp.createTemp('medbox-owned-file-tests-');
    sibling = await File('${root.path}/user-owned.txt')
        .writeAsString('preserve');
  });
  tearDown(() async {
    expect(await sibling.readAsString(), 'preserve');
    await root.delete(recursive: true); // Only the private synthetic fixture.
  });
  ExportTemporaryStore store({
    Future<void> Function(File, List<int>)? writer,
  }) => ExportTemporaryStore(
    process: ExportProcessCoordinator(
      temporaryDirectory: () async => root,
      journal: ExportOwnershipJournal(state: MemoryPrivateAtomicState()),
    ),
    writeBytes: writer,
  );

  test(
    'failed partial writes remove only the registered file and directory',
    () async {
      final files = store(
        writer: (file, bytes) async {
          await file.writeAsBytes(bytes.take(2).toList());
          throw const FileSystemException('synthetic disk failure');
        },
      );
      await expectLater(
        files.create(bytes: [1, 2, 3], extension: 'md', identityEpoch: 0),
        throwsA(isA<FileSystemException>()),
      );
      expect(root.listSync().map((f) => f.path), [sibling.path]);
    },
  );

  test(
    'identity reset drains partial write, aborts its result, then cleans it',
    () async {
      final entered = Completer<void>();
      final gate = Completer<void>();
      final files = store(
        writer: (file, bytes) async {
          await file.writeAsBytes(bytes.take(2).toList());
          entered.complete();
          await gate.future;
          await file.writeAsBytes(bytes);
        },
      );
      final pending = files.create(
        bytes: [1, 2, 3],
        extension: 'csv',
        identityEpoch: 0,
      );
      final rejected = expectLater(
        pending,
        throwsA(isA<ExportTemporaryException>()),
      );
      await entered.future;
      var cleaned = false;
      final reset = files.resetForIdentity().then((_) => cleaned = true);
      expect(files.identityEpoch, 1);
      await Future<void>.delayed(Duration.zero);
      expect(cleaned, false);
      gate.complete();
      await Future.wait([rejected, reset]);
      expect(root.listSync().map((f) => f.path), [sibling.path]);
    },
  );

  test(
    'new identity can write after old writes have been invalidated',
    () async {
      final files = store();
      final old = await files.create(
        bytes: [1],
        extension: 'md',
        identityEpoch: 0,
      );
      await files.resetForIdentity();
      expect(await old.file.exists(), false);
      await expectLater(
        files.create(bytes: [1], extension: 'md', identityEpoch: 0),
        throwsA(isA<ExportTemporaryException>()),
      );
      final fresh = await files.create(
        bytes: [2],
        extension: 'json',
        identityEpoch: 1,
        backup: true,
      );
      expect(await fresh.file.readAsBytes(), [2]);
      await fresh.release();
    },
  );

  test('unsafe extensions are rejected before creating paths', () async {
    final files = store();
    for (final extension in [
      '../escape',
      '/tmp/escape',
      'md/../../escape',
      'json\\escape',
    ]) {
      await expectLater(
        files.create(bytes: [1], extension: extension, identityEpoch: 0),
        throwsArgumentError,
      );
    }
    expect(root.listSync().map((f) => f.path), [sibling.path]);
  });

  test('unregistered sibling file and symlink inside owned directory are preserved', () async {
    final files = store();
    final owned = await files.create(
      bytes: [1],
      extension: 'pdf',
      identityEpoch: 0,
    );
    final extra = await File('${owned.file.parent.path}/user-owned.txt')
        .writeAsString('keep extra');
    final link = await Link('${owned.file.parent.path}/user-link')
        .create(sibling.path);
    await owned.release();
    expect(await owned.file.exists(), false);
    expect(await extra.readAsString(), 'keep extra');
    expect(await link.target(), sibling.path);
  });

  test(
    'registered path substituted with symlink never deletes its target',
    () async {
      final files = store();
      final owned = await files.create(
        bytes: [1],
        extension: 'pdf',
        identityEpoch: 0,
      );
      await owned.file.delete();
      await Link(owned.file.path).create(sibling.path);
      await expectLater(
        owned.release(),
        throwsA(isA<ExportTemporaryException>()),
      );
      expect(await sibling.readAsString(), 'preserve');
      expect(
        await FileSystemEntity.type(owned.file.path, followLinks: false),
        FileSystemEntityType.link,
      );
    },
  );

  test('unsafe directory cleanup fails closed, retains ownership and retries safely', () async {
    final files = store();
    final owned = await files.create(
      bytes: [1],
      extension: 'md',
      identityEpoch: 0,
    );
    final original = owned.file.parent.path;
    final moved = await owned.file.parent.rename('$original-saved');
    final external = await root.createTemp('unregistered-external-');
    final target = await File('${external.path}/medicine-inventory.md')
        .writeAsString('external');
    final link = await Link(original).create(external.path);
    final reset = files.resetForIdentity();
    expect(
      files.identityEpoch,
      1,
      reason: 'invalidation precedes any fallible cleanup',
    );
    await expectLater(reset, throwsA(isA<ExportTemporaryException>()));
    expect(await target.readAsString(), 'external');
    await link.delete();
    await moved.rename(original);
    await files.resetForIdentity();
    expect(await owned.file.exists(), false);
    expect(await target.readAsString(), 'external');
  });

  test(
    'handoff blocks stale identity and late page cancellation before send',
    () async {
      final files = store();
      final owned = await files.create(
        bytes: [1],
        extension: 'md',
        identityEpoch: 0,
      );
      var sent = false;
      await expectLater(
        files.handoff(
          owned,
          isCurrent: () => false,
          send: (_) async {
            sent = true;
          },
        ),
        throwsA(isA<ExportTemporaryException>()),
      );
      expect(sent, false);
      await files.resetForIdentity();
      await expectLater(
        files.handoff(
          owned,
          isCurrent: () => true,
          send: (_) async {
            sent = true;
          },
        ),
        throwsA(isA<ExportTemporaryException>()),
      );
      expect(sent, false);
    },
  );

  test(
    'logout does not delete an active handoff; release after return is exact',
    () async {
      final files = store();
      final owned = await files.create(
        bytes: [1, 2],
        extension: 'md',
        identityEpoch: 0,
      );
      final entered = Completer<void>();
      final gate = Completer<void>();
      final handoff = files.handoff(
        owned,
        isCurrent: () => true,
        send: (file) async {
          entered.complete();
          await gate.future;
          expect(await file.readAsBytes(), [1, 2]);
        },
      );
      await entered.future;
      await files.resetForIdentity();
      expect(await owned.file.exists(), true);
      await owned.release();
      expect(await owned.file.exists(), true);
      gate.complete();
      await handoff;
      expect(await owned.file.exists(), false);
      expect(root.listSync().map((f) => f.path), [sibling.path]);
    },
  );
  test('plugin cache, pre-existing legacy exports and unrelated directories are not swept', () async {
    final plugin = await Directory('${root.path}/share_plus').create();
    final copy = await File('${plugin.path}/shared.md')
        .writeAsString('native consumer copy');
    final legacy = await File('${root.path}/medicine-inventory-old.md')
        .writeAsString('legacy unregistered');
    final files = store();
    final owned = await files.create(
      bytes: [1],
      extension: 'md',
      identityEpoch: 0,
    );
    await files.resetForIdentity();
    expect(await owned.file.exists(), false);
    expect(await copy.readAsString(), 'native consumer copy');
    expect(await legacy.readAsString(), 'legacy unregistered');
  });
  test('native result survives cleanup failure, which remains separately retryable', () async {
    final files = store();
    final owned = await files.create(
      bytes: [1],
      extension: 'md',
      identityEpoch: 0,
    );
    final original = owned.file.parent.path;
    Directory? moved;
    Link? link;
    final result = await files.handoff(
      owned,
      isCurrent: () => true,
      send: (_) async {
        moved = await owned.file.parent.rename('$original-saved');
        link = await Link(original).create(root.path);
        return 'selected-target';
      },
    );
    expect(result, 'selected-target');
    expect(owned.cleanupError, isA<ExportTemporaryException>());
    await link!.delete();
    await moved!.rename(original);
    await files.resetForIdentity();
    expect(await owned.file.exists(), false);
    expect(owned.cleanupError, isNull);
  });
  test(
    'overlapping native share from a newer identity is rejected, never queued',
    () async {
      final files = store();
      final first = await files.create(
        bytes: [1],
        extension: 'md',
        identityEpoch: 0,
      );
      final entered = Completer<void>();
      final gate = Completer<void>();
      final pending = files.handoff(
        first,
        isCurrent: () => true,
        send: (_) async {
          entered.complete();
          await gate.future;
        },
      );
      await entered.future;
      await files.resetForIdentity();
      final second = await files.create(
        bytes: [2],
        extension: 'md',
        identityEpoch: 1,
      );
      var secondSent = false;
      await expectLater(
        files.handoff(
          second,
          isCurrent: () => true,
          send: (_) async {
            secondSent = true;
          },
        ),
        throwsA(isA<ExportTemporaryException>()),
      );
      await second.release();
      expect(secondSent, false);
      expect(await first.file.readAsBytes(), [1]);
      expect(await second.file.exists(), false);
      gate.complete();
      await pending;
      expect(await first.file.exists(), false);
    },
  );
}
