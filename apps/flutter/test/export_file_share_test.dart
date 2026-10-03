import 'package:home_medicine_flutter/data/export_ownership_journal.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';

// ignore_for_file: depend_on_referenced_packages
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:share_plus/share_plus.dart';
import 'package:share_plus_platform_interface/method_channel/method_channel_share.dart';
import 'package:home_medicine_flutter/data/export_file_share.dart';
import 'package:home_medicine_flutter/data/export_temporary_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final calls = <MethodCall>[];
  var response = 'synthetic-target';
  const channel = MethodChannel('dev.fluttercommunity.plus/share');
  setUp(() {
    calls.clear();
    response = 'synthetic-target';
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return response;
        });
  });
  test(
    'bridge dependency versions stay at their explicitly reviewed boundary',
    () {
      final source = File('pubspec.lock')
          .readAsStringSync()
          .replaceAll('\r\n', '\n');
      String version(String name, String lock) {
        final normalized = lock.replaceAll('\r\n', '\n');
        final section = RegExp(
          '^  $name:\\n([\\s\\S]*?)(?=^  [a-z_]+:|\\z)',
          multiLine: true,
        ).firstMatch(normalized);
        expect(section, isNotNull);
        return RegExp(r'version: "([^"]+)"')
            .firstMatch(section!.group(1)!)!
            .group(1)!;
      }

      for (final lineEnding in ['\n', '\r\n']) {
        final lock = source.replaceAll('\n', lineEnding);
        expect(
          version('share_plus', lock),
          ExportFileShare.testedSharePlusVersion,
        );
        expect(
          version('share_plus_platform_interface', lock),
          ExportFileShare.testedPlatformInterfaceVersion,
        );
      }
    },
  );

  test(
    'single-file payload matches locked share_plus bridge exactly',
    () async {
      final file = File('/synthetic/already-written.md');
      await MethodChannelShare().share(
        ShareParams(
          files: [XFile(file.path, mimeType: 'text/markdown')],
          subject: 'synthetic subject',
          text: 'synthetic text',
        ),
      );
      await ExportFileShare.share(
        file: file,
        mimeType: 'text/markdown',
        subject: 'synthetic subject',
        text: 'synthetic text',
        isCurrent: () => true,
      );
      expect(calls, hasLength(2));
      expect(calls[0].method, calls[1].method);
      expect(calls[0].arguments, calls[1].arguments);
    },
  );
  test(
    'stale identity is rejected before the real native method channel',
    () async {
      await expectLater(
        ExportFileShare.share(
          file: File('/synthetic/a.md'),
          mimeType: 'text/markdown',
          subject: 's',
          text: 't',
          isCurrent: () => false,
        ),
        throwsA(isA<ExportTemporaryException>()),
      );
      expect(calls, isEmpty);
    },
  );
  for (final result in [
    '',
    'dev.fluttercommunity.plus/share/unavailable',
    'synthetic-target',
  ]) {
    test('result $result retains native share status semantics', () async {
      response = result;
      final native = await MethodChannelShare().share(
        ShareParams(
          files: [XFile('/synthetic/a.md', mimeType: 'text/markdown')],
        ),
      );
      final guarded = await ExportFileShare.share(
        file: File('/synthetic/a.md'),
        mimeType: 'text/markdown',
        subject: 's',
        text: 't',
        isCurrent: () => true,
      );
      expect(guarded.raw, native.raw);
      expect(guarded.status, native.status);
    });
  }
  test(
    'identity reset during owned-file preflight prevents native dispatch',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'export-native-order-',
      );
      addTearDown(() => root.delete(recursive: true));
      final store = ExportTemporaryStore(
        process: ExportProcessCoordinator(
          temporaryDirectory: () async => root,
          journal: ExportOwnershipJournal(state: MemoryPrivateAtomicState()),
        ),
      );
      final owned = await store.create(
        bytes: [65],
        extension: 'md',
        identityEpoch: 0,
      );
      final nativeEpochs = <int>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            nativeEpochs.add(store.identityEpoch);
            return 'synthetic-target';
          });
      final handoff = store.handoff(
        owned,
        isCurrent: () => store.identityEpoch == 0,
        send: (file) => ExportFileShare.share(
          file: file,
          mimeType: 'text/markdown',
          subject: 's',
          text: 't',
          isCurrent: () => store.identityEpoch == 0,
        ),
      );
      final rejected = expectLater(
        handoff,
        throwsA(isA<ExportTemporaryException>()),
      );
      final reset = store.resetForIdentity();
      await Future.wait([rejected, reset]);
      expect(
        nativeEpochs,
        isEmpty,
        reason: 'Preflight rechecks identity before the final synchronous native boundary',
      );
      expect(await owned.file.exists(), false);
    },
  );

  test(
    'null native result remains unavailable, not a delivery success',
    () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (_) async => null);
      final result = await ExportFileShare.share(
        file: File('/synthetic/a.md'),
        mimeType: 'text/markdown',
        subject: 's',
        text: 't',
        isCurrent: () => true,
      );
      expect(result.status, ShareResultStatus.unavailable);
    },
  );

  test('native PlatformException is preserved', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (_) async =>
              throw PlatformException(code: 'synthetic-native-failure'),
        );
    await expectLater(
      ExportFileShare.share(
        file: File('/synthetic/a.md'),
        mimeType: 'text/markdown',
        subject: 's',
        text: 't',
        isCurrent: () => true,
      ),
      throwsA(
        isA<PlatformException>().having(
          (e) => e.code,
          'code',
          'synthetic-native-failure',
        ),
      ),
    );
  });

  test('invalid empty single-file input cannot reach native channel', () async {
    await expectLater(
      ExportFileShare.share(
        file: File(''),
        mimeType: 'text/markdown',
        subject: 's',
        text: 't',
        isCurrent: () => true,
      ),
      throwsArgumentError,
    );
    await expectLater(
      ExportFileShare.share(
        file: File('/synthetic/a.md'),
        mimeType: 'text/markdown',
        subject: 's',
        text: '',
        isCurrent: () => true,
      ),
      throwsArgumentError,
    );
    expect(calls, isEmpty);
  });
}
