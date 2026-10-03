import 'dart:convert';

import 'app_stores.dart';

class MedicineDraftQueue {
  MedicineDraftQueue(this.store, {this.isCurrent, this.scope});
  final LocalAppStore store;
  // A page may bind this queue to the identity that owns its draft intent.
  // Recheck after reads: store-level write fencing cannot reject a stale
  // callback that only enqueues its write after identity cleanup completed.
  final bool Function()? isCurrent;
  // Equal original-identity scopes share ordering across page instances.
  // A replacement identity must supply a different scope, so an obsolete read
  // cannot hold its queue. Unscoped callers share one default lane per store;
  // scope alone is not authority and never replaces the isCurrent guard.
  final Object? scope;
  static final _defaultScope = Object();
  static final _pending = Expando<Map<Object, Future<void>>>();

  Future<void> _mutate(Future<void> Function() operation) {
    final scopes = _pending[store] ??= <Object, Future<void>>{};
    final key = scope ?? _defaultScope;
    final next = (scopes[key] ?? Future<void>.value()).then((_) async {
      if (isCurrent?.call() ?? true) await operation();
    });
    // Keep failures observable to this caller, but allow the next mutation.
    // Remove idle scope keys and captured closures; the store key is weak.
    late final Future<void> settled;
    void release() {
      if (identical(scopes[key], settled)) scopes.remove(key);
    }

    settled = next.then<void>(
      (_) => release(),
      onError: (Object _) => release(),
    );
    scopes[key] = settled;
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
        if (!(isCurrent?.call() ?? true)) return;
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
    if (!(isCurrent?.call() ?? true)) return;
    entries.removeWhere((item) => item['id'] == id);
    await store.saveDraft(storageKey, jsonEncode(entries));
  });
}
