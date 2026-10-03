import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';

class _PausedReadStore extends MemoryInventoryLocalStore {
  final entered = Completer<void>();
  final release = Completer<String?>();
  bool pause = true;
  @override
  Future<String?> readDraft(String key) async {
    if (pause && key == MedicineDraftQueue.storageKey) {
      pause = false;
      entered.complete();
      return release.future;
    }
    return super.readDraft(key);
  }
}

class _FailOnceStore extends MemoryInventoryLocalStore {
  bool fail = true;
  @override
  Future<void> saveDraft(String key, String json) async {
    if (fail) {
      fail = false;
      throw StateError('synthetic storage failure');
    }
    await super.saveDraft(key, json);
  }
}

void main() {
  test(
    'equal immutable scopes serialize save and remove across queue instances',
    () async {
      final store = MemoryInventoryLocalStore();
      final first = MedicineDraftQueue(
        store,
        scope: ('owner-a', 1),
        isCurrent: () => true,
      );
      final second = MedicineDraftQueue(
        store,
        scope: ('owner-a', 1),
        isCurrent: () => true,
      );
      await Future.wait([
        first.save('a', {'name': 'first'}),
        second.save('b', {'name': 'second'}),
        first.remove('a'),
        second.save('c', {'name': 'third'}),
      ]);
      expect(await first.list(), [
        {'name': 'second', 'id': 'b'},
        {'name': 'third', 'id': 'c'},
      ]);
    },
  );

  for (final remove in [false, true]) {
    test(
      'replacement scope progresses before stale ${remove ? 'remove' : 'save'} read resumes',
      () async {
        final raw = _PausedReadStore();
        final store = IdentityLocalStore(raw);
        var oldCurrent = true;
        final oldQueue = MedicineDraftQueue(
          store,
          scope: ('owner-a', 1),
          isCurrent: () => oldCurrent,
        );
        final old = remove
            ? oldQueue.remove('a')
            : oldQueue.save('a', {'name': 'old owner'});
        await raw.entered.future;
        oldCurrent = false;
        await store.clearFamilyData();
        final newQueue = MedicineDraftQueue(
          store,
          scope: ('owner-b', 2),
          isCurrent: () => true,
        );
        try {
          // A store-global tail would time out here: old read is still paused.
          await newQueue
              .save('b', {'name': 'new owner'})
              .timeout(const Duration(seconds: 1));
        } finally {
          raw.release.complete('[{"id":"a","name":"old owner"}]');
        }
        await old;
        expect(await newQueue.list(), [
          {'name': 'new owner', 'id': 'b'},
        ]);
      },
    );
  }

  test(
    'same scope on another store is independent of a suspended read',
    () async {
      final slow = _PausedReadStore();
      final first = MedicineDraftQueue(slow, scope: 'same');
      final old = first.save('a', {'name': 'slow'});
      await slow.entered.future;
      final fast = MemoryInventoryLocalStore();
      final second = MedicineDraftQueue(fast, scope: 'same');
      try {
        await second
            .save('b', {'name': 'fast'})
            .timeout(const Duration(seconds: 1));
      } finally {
        slow.release.complete(null);
      }
      await old;
      expect((await second.list()).single['id'], 'b');
      expect((await first.list()).single['id'], 'a');
    },
  );

  test(
    'failed mutation does not poison another queue or later idle-scope reuse',
    () async {
      final store = _FailOnceStore();
      final first = MedicineDraftQueue(store, scope: 'current');
      final second = MedicineDraftQueue(store, scope: 'current');
      final failure = expectLater(
        first.save('a', {'name': 'failed'}),
        throwsStateError,
      );
      final success = second.save('b', {'name': 'retained'});
      await failure;
      await success;
      await MedicineDraftQueue(
        store,
        scope: 'current',
      ).save('c', {'name': 'later'});
      expect(
        (jsonDecode(store.drafts[MedicineDraftQueue.storageKey]!) as List)
            .map((entry) => entry['id'])
            .toSet(),
        {'b', 'c'},
      );
    },
  );
}
