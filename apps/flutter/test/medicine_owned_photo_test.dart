import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/medicine_owned_photo.dart';

import 'support/symlink_capability.dart';

void main() {
  late Directory support;
  late Directory directory;
  late File file;
  late Map<String, dynamic> photo;
  setUp(() async {
    support = await Directory.systemTemp.createTemp('medbox-owned-cleanup-');
    directory = await Directory('${support.path}/medicine-draft-images')
        .create(recursive: true);
    directory = await directory.createTemp('draft-box_front-');
    file = await File('${directory.path}/original.png').writeAsBytes([1, 2, 3]);
    photo = {
      'path': file.path,
      'purpose': 'box_front',
      'ownedLocal': {
        'supportPath': support.path,
        'directory': directory.path,
        'draftId': 'draft',
        'purpose': 'box_front',
        'path': file.path,
      },
    };
  });
  tearDown(() async {
    await support.delete(recursive: true);
  });
  Future<bool> clean({bool Function()? current}) => cleanupMedicinePhoto(
    supportPath: support.path,
    draftId: 'draft',
    photo: photo,
    isCurrent: current ?? () => true,
  );
  test('owned exact file and its empty directory are removed, with idempotent recovery', () async {
    expect(await clean(), true);
    expect(await file.exists(), false);
    expect(await directory.exists(), false);
    expect(await clean(), true);
  });
  test('legacy unknown files are preserved', () async {
    photo.remove('ownedLocal');
    expect(await clean(), false);
    expect(await file.readAsBytes(), [1, 2, 3]);
  });
  test(
    'wrong draft, purpose, root and path receipts cannot delete an original',
    () async {
      final owner = Map<String, dynamic>.from(photo['ownedLocal'] as Map);
      for (final change in [
        {'draftId': 'other'},
        {'purpose': 'expiry'},
        {'supportPath': '${support.path}/other'},
        {'path': '${file.path}.other'},
      ]) {
        photo['ownedLocal'] = {...owner, ...change};
        expect(await clean(), false);
        expect(await file.exists(), true);
      }
    },
  );
  test('changed identity never deletes a file', () async {
    expect(await clean(current: () => false), false);
    expect(await file.exists(), true);
  });
  test('an unknown sibling is preserved and failed empty-directory cleanup can retry', () async {
    final sibling = await File('${directory.path}/unknown.txt')
        .writeAsString('keep');
    expect(await clean(), false);
    expect(await sibling.readAsString(), 'keep');
    expect(await file.exists(), false);
    await sibling.delete();
    expect(await clean(), true);
  });
  test('a symlink is never followed or deleted as an owned photo', () async {
    if (!await requireSymbolicLinks()) return;
    final target = await File('${support.path}/unrelated.png')
        .writeAsBytes([8, 9]);
    await file.delete();
    await Link(file.path).create(target.path);
    expect(await clean(), false);
    expect(await target.readAsBytes(), [8, 9]);
    await Link(file.path).delete();
  });
  test('trusted SDK support alias resolves to the same root and cleans only its own copy', () async {
    if (!await requireSymbolicLinks()) return;
    final alias = Link('${support.path}/system-support-alias');
    await alias.create(support.path);
    try {
      final unrelated = await File('${support.path}/unrelated.txt')
          .writeAsString('keep');
      expect(
        await cleanupMedicinePhoto(
          supportPath: alias.path,
          draftId: 'draft',
          photo: photo,
          isCurrent: () => true,
        ),
        true,
      );
      expect(await file.exists(), false);
      expect(await unrelated.readAsString(), 'keep');
    } finally {
      await alias.delete();
    }
  });
  test('an owned-directory link under the trusted root is rejected', () async {
    if (!await requireSymbolicLinks()) return;
    final moved = await directory.rename('${support.path}/preserved-target');
    final link = Link(directory.path);
    await link.create(moved.path);
    try {
      expect(await clean(), false);
      expect(await File('${moved.path}/original.png').readAsBytes(), [1, 2, 3]);
    } finally {
      await link.delete();
    }
  });
  test('a root-directory link below trusted support is rejected', () async {
    if (!await requireSymbolicLinks()) return;
    final root = directory.parent;
    final moved = await root.rename('${support.path}/preserved-root');
    final link = Link(root.path);
    await link.create(moved.path);
    try {
      expect(await clean(), false);
      expect(
        await File(
          '${moved.path}/${directory.uri.pathSegments.where((part) => part.isNotEmpty).last}/original.png',
        ).readAsBytes(),
        [1, 2, 3],
      );
    } finally {
      await link.delete();
    }
  });
}
