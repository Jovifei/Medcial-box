import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/medicine_owned_photo.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  late Directory sandbox;
  late Directory root;
  late Directory owned;
  late File photo;
  late Map<String, dynamic> receipt;

  setUp(() async {
    final sdkSupport = await getApplicationSupportDirectory();
    final canonical = Directory(await sdkSupport.resolveSymbolicLinks());
    binding.reportData = {
      'sdkSupportUsesCanonicalAlias':
          sdkSupport.absolute.uri.normalizePath() !=
          canonical.absolute.uri.normalizePath(),
    };
    sandbox = await sdkSupport.createTemp('medbox-owned-integration-');
    root = await Directory('${sandbox.path}/medicine-draft-images').create();
    owned = await root.createTemp('draft-box_front-');
    photo = await File('${owned.path}/original.png').writeAsBytes([1, 2, 3]);
    receipt = {
      'path': photo.path,
      'purpose': 'box_front',
      'ownedLocal': {
        'supportPath': sandbox.path,
        'directory': owned.path,
        'draftId': 'draft',
        'purpose': 'box_front',
        'path': photo.path,
      },
    };
  });

  // Delete only exact resources allocated by this test. Empty-directory deletion
  // fails if anything unexpected exists; never recursively walk SDK support.
  tearDown(() async {
    if (await FileSystemEntity.type(photo.path, followLinks: false) ==
        FileSystemEntityType.file) {
      await photo.delete();
    }
    if (await owned.exists()) await owned.delete();
    if (await root.exists()) await root.delete();
    if (await sandbox.exists()) await sandbox.delete();
  });

  Future<bool> clean() => cleanupMedicinePhoto(
    supportPath: sandbox.path,
    draftId: 'draft',
    photo: receipt,
    isCurrent: () => true,
  );

  testWidgets(
    'Android owned copy cleanup uses the real SDK support namespace',
    (tester) async {
      expect(await clean(), isTrue);
      expect(await photo.exists(), isFalse);
      expect(await owned.exists(), isFalse);
      expect(await clean(), isTrue);
    },
  );

  testWidgets('Android unknown receipt preserves its synthetic photo bytes', (
    tester,
  ) async {
    receipt.remove('ownedLocal');
    expect(await clean(), isFalse);
    expect(await photo.readAsBytes(), [1, 2, 3]);
  });

  testWidgets('Android descendant link cannot delete an outside sentinel', (
    tester,
  ) async {
    final outside = await sandbox.createTemp('outside-owned-root-');
    final sentinel = await File('${outside.path}/original.png')
        .writeAsBytes([8, 9]);
    await photo.delete();
    final link = Link(photo.path);
    try {
      await link.create(sentinel.path);
      expect(await clean(), isFalse);
      expect(await sentinel.readAsBytes(), [8, 9]);
      expect(
        await FileSystemEntity.type(link.path, followLinks: false),
        FileSystemEntityType.link,
      );
    } finally {
      if (await FileSystemEntity.type(link.path, followLinks: false) ==
          FileSystemEntityType.link) {
        await link.delete();
      }
      await sentinel.delete();
      await outside.delete();
    }
  });

  testWidgets('Android linked photo root preserves an outside synthetic copy', (
    tester,
  ) async {
    final outside = await sandbox.createTemp('outside-photo-root-');
    final name = owned.uri.pathSegments.where((part) => part.isNotEmpty).last;
    final outsideOwned = await Directory('${outside.path}/$name').create();
    final sentinel = await File('${outsideOwned.path}/original.png')
        .writeAsBytes([8, 9]);
    await photo.delete();
    await owned.delete();
    await root.delete();
    final link = Link(root.path);
    try {
      await link.create(outside.path);
      expect(await clean(), isFalse);
      expect(await sentinel.readAsBytes(), [8, 9]);
    } finally {
      if (await FileSystemEntity.type(link.path, followLinks: false) ==
          FileSystemEntityType.link) {
        await link.delete();
      }
      await sentinel.delete();
      await outsideOwned.delete();
      await outside.delete();
    }
  });
}
