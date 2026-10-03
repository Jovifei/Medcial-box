import 'dart:convert';

import 'app_stores.dart';

class MedicineDraftQueue {
  MedicineDraftQueue(this.store);
  final LocalAppStore store;
  Future<void> _tail = Future.value();
  Future<void> _mutate(Future<void> Function() operation) {
    final next = _tail.then((_) => operation());
    _tail = next.catchError((Object _) {});
    return next;
  }

  static const storageKey = 'medicine-entry-queue.v1';
  Future<List<Map<String, dynamic>>> list() async {
    final raw = await store.readDraft(storageKey);
    if (raw == null) return [];
    return (jsonDecode(raw) as List<dynamic>)
        .whereType<Map<String, dynamic>>()
        .toList();
  }

  Future<void> save(String id, Map<String, dynamic> fields) =>
      _mutate(() async {
        final entries = await list();
        final index = entries.indexWhere((item) => item['id'] == id);
        if (index < 0 && entries.length >= 10) {
          throw StateError('最多保留10份草稿，请先保存或删除一份。');
        }
        final draft = {...fields, 'id': id};
        if (index < 0) {
          entries.add(draft);
        } else {
          entries.removeAt(index);
          entries.add(draft);
        }
        await store.saveDraft(storageKey, jsonEncode(entries));
      });
  Future<void> remove(String id) => _mutate(() async {
    final entries = await list();
    entries.removeWhere((item) => item['id'] == id);
    await store.saveDraft(storageKey, jsonEncode(entries));
  });
}
