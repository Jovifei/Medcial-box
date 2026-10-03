import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';

class _DelayedReadStore extends MemoryInventoryLocalStore {
  final entered = Completer<void>();
  final release = Completer<String?>();
  bool block = true;
  @override
  Future<String?> readDraft(String key) async {
    if (block && key == MedicineDraftQueue.storageKey) {
      block = false;
      entered.complete();
      return release.future;
    }
    return super.readDraft(key);
  }
}

void main() {
  for (final remove in [false, true]) {
    test(
      'stale ${remove ? 'remove' : 'save'} cannot commit after replacement identity cleanup',
      () async {
        final raw = _DelayedReadStore();
        final local = IdentityLocalStore(raw);
        var current = true;
        final queue = MedicineDraftQueue(local, isCurrent: () => current);
        final pending = remove
            ? queue.remove('old')
            : queue.save('old', {'name': 'old owner'});
        await raw.entered.future;
        current = false;
        await local.clearFamilyData();
        const replacement = [
          {'id': 'new', 'name': 'new owner'},
        ];
        await local.saveDraft(
          MedicineDraftQueue.storageKey,
          jsonEncode(replacement),
        );
        raw.release.complete('[{"id":"old","name":"old owner"}]');
        await pending;
        expect(
          jsonDecode(raw.drafts[MedicineDraftQueue.storageKey]!),
          replacement,
        );
      },
    );
  }

  test(
    'same-instance concurrent writes remain serialized with a current identity',
    () async {
      final store = MemoryInventoryLocalStore();
      final queue = MedicineDraftQueue(store, isCurrent: () => true);
      await Future.wait([
        queue.save('a', {'name': 'first'}),
        queue.save('b', {'name': 'second'}),
        queue.save('a', {'name': 'latest'}),
      ]);
      expect(await queue.list(), [
        {'name': 'second', 'id': 'b'},
        {'name': 'latest', 'id': 'a'},
      ]);
    },
  );

  test('queued operations are dropped when the original identity is no longer current', () async {
    final raw = _DelayedReadStore();
    var current = true;
    final queue = MedicineDraftQueue(raw, isCurrent: () => current);
    final first = queue.save('a', {'name': 'first'});
    await raw.entered.future;
    final second = queue.save('b', {'name': 'second'});
    current = false;
    raw.release.complete(null);
    await Future.wait([first, second]);
    expect(raw.drafts, isEmpty);
  });
}
