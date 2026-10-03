import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/core/theme/app_theme.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:http/testing.dart';

const _legacyKey = 'medicine-entry';
const _captureKey = ValueKey('back-test-capture');

class _ControlledStore extends MemoryInventoryLocalStore {
  String? failWriteKey;
  bool failDelete = false;
  bool failAfterWrite = false;
  Completer<void>? writeGate;
  Completer<void>? readGate;
  Completer<void>? deleteGate;
  final writes = <String>[];

  @override
  Future<String?> readDraft(String key) async {
    final gate = key == MedicineDraftQueue.storageKey ? readGate : null;
    if (gate != null) {
      readGate = null;
      final snapshot = await super.readDraft(key);
      await gate.future;
      return snapshot;
    }
    return super.readDraft(key);
  }

  @override
  Future<void> saveDraft(String key, String json) async {
    writes.add(key);
    if (failWriteKey == key) throw StateError('synthetic write failure');
    final gate = writeGate;
    writeGate = null;
    if (gate != null) await gate.future;
    if (failAfterWrite) throw StateError('synthetic delayed failure');
    await super.saveDraft(key, json);
  }

  @override
  Future<void> deleteDraft(String key) async {
    if (failDelete) throw StateError('synthetic delete failure');
    final gate = deleteGate;
    deleteGate = null;
    if (gate != null) await gate.future;
    await super.deleteDraft(key);
  }
}

class _EntryFixture {
  _EntryFixture(this.api, this.navigator);
  final ApiClient api;
  final GlobalKey<NavigatorState> navigator;
}

Future<_EntryFixture> _openEntry(
  WidgetTester tester,
  LocalAppStore store, {
  SessionIdentityState? identity,
}) async {
  tester.view.physicalSize = const Size(360, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final navigator = GlobalKey<NavigatorState>();
  final api = ApiClient(
    baseUrl: 'https://synthetic.invalid',
    tokenProvider: () async => null,
    identityState: identity,
    client: MockClient((request) async {
      throw StateError('No network expected: ${request.method}');
    }),
  );
  await tester.pumpWidget(
    RepaintBoundary(
      key: _captureKey,
      child: MaterialApp(
        navigatorKey: navigator,
        theme: appTheme,
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          body: Center(
            child: FilledButton(
              onPressed: () => navigator.currentState!.push(
                MaterialPageRoute<void>(
                  builder: (_) => MedicineEntryApiPage(
                    repository: ApiMedicineRepository(
                      api: api,
                      localStore: store,
                    ),
                    workflow: ApiWorkflowRepository(api: api),
                    localStore: store,
                  ),
                ),
              ),
              child: const Text('打开测试录入页'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('打开测试录入页'));
  await tester.pumpAndSettle();
  return _EntryFixture(api, navigator);
}

Future<void> _edit(WidgetTester tester, String name) async {
  final field = find.byType(TextField).first;
  await tester.ensureVisible(field);
  await tester.enterText(field, name);
  await tester.pump(const Duration(milliseconds: 250));
}

Future<List<Object>> _leave(WidgetTester tester, String action) async {
  final errors = <Object>[];
  await runZonedGuarded(() async {
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    await tester.tap(find.text(action));
    await tester.pumpAndSettle();
  }, (error, _) => errors.add(error));
  return errors;
}

String _name(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField).first).controller!.text;

void _expectProtected(WidgetTester tester, String name) {
  expect(find.byType(MedicineEntryApiPage), findsOneWidget);
  expect(_name(tester), name);
  expect(
    tester
        .widget<PopScope<Object?>>(
          find.byKey(const ValueKey('medicine-entry-pop-scope')),
        )
        .canPop,
    isFalse,
  );
}

Future<void> _capture(WidgetTester tester, String name) async {
  const directory = String.fromEnvironment('BACK_TEST_CAPTURE');
  if (directory.isEmpty) return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(_captureKey),
  );
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('$directory/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    if (const String.fromEnvironment('BACK_TEST_CAPTURE').isEmpty) return;
    await (FontLoader('sans')
          ..addFont(rootBundle.load('assets/fonts/MedBoxSansSC-Regular.ttf')))
        .load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  for (final failingKey in [MedicineDraftQueue.storageKey, _legacyKey]) {
    testWidgets('keep failure at $failingKey preserves fields and can retry', (
      tester,
    ) async {
      final store = _ControlledStore();
      await _openEntry(tester, store);
      await _edit(tester, '失败保留合成药品');
      store.failWriteKey = failingKey;
      final errors = await _leave(tester, '保留草稿');
      await _capture(
        tester,
        'keep-failure-${failingKey == _legacyKey ? 'legacy' : 'queue'}',
      );
      _expectProtected(tester, '失败保留合成药品');
      expect(errors, isEmpty);
      expect(find.text('草稿保存失败，内容仍在当前页面。请重试。'), findsOneWidget);
      store.failWriteKey = null;
      await tester.tap(find.text('重试'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('保留草稿'));
      await tester.pumpAndSettle();
      expect(find.byType(MedicineEntryApiPage), findsNothing);
      expect(jsonDecode(store.drafts[_legacyKey]!)['name'], '失败保留合成药品');
    });
  }

  for (final failQueue in [false, true]) {
    testWidgets(
      'discard ${failQueue ? 'queue' : 'legacy'} failure preserves fields and can retry',
      (tester) async {
        final store = _ControlledStore();
        await _openEntry(tester, store);
        await _edit(tester, '删除失败合成药品');
        store.failDelete = !failQueue;
        store.failWriteKey = failQueue ? MedicineDraftQueue.storageKey : null;
        final errors = await _leave(tester, '放弃修改');
        await _capture(
          tester,
          'discard-failure-${failQueue ? 'queue' : 'legacy'}',
        );
        _expectProtected(tester, '删除失败合成药品');
        expect(errors, isEmpty);
        expect(find.text('草稿删除失败，内容仍在当前页面。请重试。'), findsOneWidget);
        store.failDelete = false;
        store.failWriteKey = null;
        await _leave(tester, '放弃修改');
        expect(find.byType(MedicineEntryApiPage), findsNothing);
        expect(store.drafts[_legacyKey], isNull);
        expect(
          jsonDecode(store.drafts[MedicineDraftQueue.storageKey]!),
          isEmpty,
        );
      },
    );
  }

  testWidgets(
    'pending keep retains newer edits and ignores repeated Back and draft switching',
    (tester) async {
      final store = _ControlledStore();
      await _openEntry(tester, store);
      await _edit(tester, '等待保留初稿');
      final gate = store.writeGate = Completer<void>();
      expect(await _leave(tester, '保留草稿'), isEmpty);
      await _edit(tester, '等待期间新编辑');
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      await _capture(tester, 'pending-keep-repeated-back');
      final duplicateDialog = find.text('保留这次录入？').evaluate().isNotEmpty;
      final switchEnabled =
          tester
              .widget<IconButton>(
                find.byWidgetPredicate(
                  (widget) => widget is IconButton && widget.tooltip == '本机草稿',
                ),
              )
              .onPressed !=
          null;
      gate.complete();
      await tester.pumpAndSettle();
      expect(duplicateDialog, isFalse);
      expect(switchEnabled, isFalse);
      expect(find.byType(MedicineEntryApiPage), findsNothing);
      expect(jsonDecode(store.drafts[_legacyKey]!)['name'], '等待期间新编辑');
      expect(
        (jsonDecode(
          store.drafts[MedicineDraftQueue.storageKey]!,
        ) as List).single['name'],
        '等待期间新编辑',
      );
    },
  );

  testWidgets('continuing a prompt resumes the pending autosave', (
    tester,
  ) async {
    final store = _ControlledStore();
    await _openEntry(tester, store);
    await tester.ensureVisible(find.byType(TextField).first);
    await tester.enterText(find.byType(TextField).first, '继续后仍自动保留');
    await tester.pump();
    // Back arrives before the 200 ms autosave timer fires.
    await _leave(tester, '继续编辑');
    await tester.pump(const Duration(milliseconds: 250));
    _expectProtected(tester, '继续后仍自动保留');
    expect(
      (jsonDecode(
        store.drafts[MedicineDraftQueue.storageKey]!,
      ) as List).single['name'],
      '继续后仍自动保留',
    );
    expect(store.drafts[_legacyKey], isNull);
  });

  testWidgets(
    'a write that fails after newer edits leaves those edits retryable',
    (tester) async {
      final store = _ControlledStore();
      await _openEntry(tester, store);
      await _edit(tester, '写入开始时的内容');
      final gate = store.writeGate = Completer<void>();
      await _leave(tester, '保留草稿');
      await _edit(tester, '失败前的新编辑');
      store.failAfterWrite = true;
      gate.complete();
      await tester.pumpAndSettle();
      _expectProtected(tester, '失败前的新编辑');
      expect(find.text('草稿保存失败，内容仍在当前页面。请重试。'), findsOneWidget);
      store.failAfterWrite = false;
      await _leave(tester, '保留草稿');
      expect(find.byType(MedicineEntryApiPage), findsNothing);
      expect(jsonDecode(store.drafts[_legacyKey]!)['name'], '失败前的新编辑');
      expect(
        (jsonDecode(
          store.drafts[MedicineDraftQueue.storageKey]!,
        ) as List).single['name'],
        '失败前的新编辑',
      );
    },
  );

  testWidgets(
    'keep completion cannot pop a newer external route or clear the original intent',
    (tester) async {
      final store = _ControlledStore();
      final fixture = await _openEntry(tester, store);
      await _edit(tester, '原页面编辑');
      final gate = store.writeGate = Completer<void>();
      await _leave(tester, '保留草稿');
      fixture.navigator.currentState!.push(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('新的外部页面')),
        ),
      );
      await tester.pumpAndSettle();
      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text('新的外部页面'), findsOneWidget);
      fixture.navigator.currentState!.pop();
      await tester.pumpAndSettle();
      _expectProtected(tester, '原页面编辑');
      await _leave(tester, '保留草稿');
      expect(find.byType(MedicineEntryApiPage), findsNothing);
    },
  );

  testWidgets(
    'keep completion after replacement never pops the replacement route',
    (tester) async {
      final store = _ControlledStore();
      final fixture = await _openEntry(tester, store);
      await _edit(tester, '待替换的页面');
      final gate = store.writeGate = Completer<void>();
      await _leave(tester, '保留草稿');
      fixture.navigator.currentState!.pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('替换后的页面')),
        ),
      );
      await tester.pumpAndSettle();
      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text('替换后的页面'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'edits made during delayed discard stay available for a new decision',
    (tester) async {
      final store = _ControlledStore();
      await _openEntry(tester, store);
      await _edit(tester, '确认放弃的内容');
      final gate = store.deleteGate = Completer<void>();
      await _leave(tester, '放弃修改');
      await _edit(tester, '删除期间的新编辑');
      gate.complete();
      await tester.pumpAndSettle();
      _expectProtected(tester, '删除期间的新编辑');
      await _leave(tester, '保留草稿');
      expect(jsonDecode(store.drafts[_legacyKey]!)['name'], '删除期间的新编辑');
    },
  );

  for (final action in ['保留草稿', '放弃修改']) {
    testWidgets(
      'identity switch during delayed $action read cannot touch replacement drafts',
      (tester) async {
        final raw = _ControlledStore();
        final store = IdentityLocalStore(raw);
        final fixture = await _openEntry(tester, store);
        await _edit(tester, '旧身份草稿');
        final gate = raw.readGate = Completer<void>();
        await _leave(tester, action);
        fixture.api.invalidateIdentity();
        await store.clearFamilyData();
        raw.drafts[MedicineDraftQueue.storageKey] =
            '[{"id":"new","name":"新身份草稿"}]';
        raw.drafts[_legacyKey] = '{"id":"new","name":"新身份草稿"}';
        gate.complete();
        await tester.pumpAndSettle();
        expect(jsonDecode(raw.drafts[MedicineDraftQueue.storageKey]!), [
          {'id': 'new', 'name': '新身份草稿'},
        ]);
        expect(jsonDecode(raw.drafts[_legacyKey]!)['name'], '新身份草稿');
        _expectProtected(tester, '旧身份草稿');
        await _edit(tester, '已失效页面再次编辑');
        expect(jsonDecode(raw.drafts[_legacyKey]!)['name'], '新身份草稿');
        expect(jsonDecode(raw.drafts[MedicineDraftQueue.storageKey]!), [
          {'id': 'new', 'name': '新身份草稿'},
        ]);
      },
    );
  }

  testWidgets(
    'entry autosave read cannot overwrite a new owner after real identity cleanup',
    (tester) async {
      final raw = _ControlledStore();
      final store = IdentityLocalStore(raw);
      final fixture = await _openEntry(tester, store);
      final gate = raw.readGate = Completer<void>();
      await _edit(tester, '旧身份自动保存草稿');
      fixture.api.invalidateIdentity();
      await store.clearFamilyData();
      await store.saveDraft(
        MedicineDraftQueue.storageKey,
        '[{"id":"new","name":"新身份草稿"}]',
      );
      await store.saveDraft(_legacyKey, '{"id":"new","name":"新身份草稿"}');
      gate.complete();
      await tester.pumpAndSettle();
      expect(jsonDecode(raw.drafts[MedicineDraftQueue.storageKey]!), [
        {'id': 'new', 'name': '新身份草稿'},
      ]);
      expect(jsonDecode(raw.drafts[_legacyKey]!)['name'], '新身份草稿');
      _expectProtected(tester, '旧身份自动保存草稿');
    },
  );

  testWidgets(
    'identity cleanup drains an in-flight write without stale legacy continuation',
    (tester) async {
      final raw = _ControlledStore();
      final store = IdentityLocalStore(raw);
      final fixture = await _openEntry(tester, store);
      await _edit(tester, '旧身份进行中');
      final gate = raw.writeGate = Completer<void>();
      await _leave(tester, '保留草稿');
      fixture.api.invalidateIdentity();
      final cleanup = store.clearFamilyData();
      gate.complete();
      await tester.pumpAndSettle();
      await cleanup;
      expect(raw.drafts, isEmpty);
      expect(raw.writes.where((key) => key == _legacyKey), isEmpty);
      _expectProtected(tester, '旧身份进行中');
    },
  );

  testWidgets(
    'owner change without epoch change invalidates a pending dialog',
    (tester) async {
      final identity = SessionIdentityState(
        origin: 'https://synthetic.invalid',
        secrets: MemorySecretStore(),
        persistence: MemoryPrivateAtomicState(),
      );
      await identity.initialize();
      await identity.acceptToken(identity.beginLink(), 'synthetic-session');
      await identity.recordOwner(
        expectedGeneration: identity.generation!,
        userId: 'synthetic-user',
        familyId: 'family-a',
        isCurrent: () => true,
      );
      final store = _ControlledStore();
      await _openEntry(tester, store, identity: identity);
      await _edit(tester, '原家庭草稿');
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      await identity.recordOwner(
        expectedGeneration: identity.generation!,
        userId: 'synthetic-user',
        familyId: 'family-b',
        isCurrent: () => true,
      );
      final writes = store.writes.length;
      await tester.tap(find.text('保留草稿'));
      await tester.pumpAndSettle();
      expect(store.writes.length, writes);
      _expectProtected(tester, '原家庭草稿');
    },
  );
}
