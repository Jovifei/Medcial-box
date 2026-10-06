import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _legacy = 'medicine-entry';
const _replacementQueue = '[{"id":"new-owner","name":"replacement draft"}]';
const _replacementLegacy = '{"id":"new-owner","name":"replacement draft"}';

class _DraftStore extends MemoryInventoryLocalStore {
  Completer<void>? readGate;
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
}

class _Photo extends XFile {
  _Photo() : super('synthetic-expiry.png');
  final entered = Completer<void>();
  final release = Completer<Uint8List>();
  @override
  Future<Uint8List> readAsBytes() {
    entered.complete();
    return release.future;
  }
}

class _Fixture {
  _Fixture({SessionIdentityState? identity}) {
    store = IdentityLocalStore(raw);
    api = ApiClient(
      baseUrl: 'https://synthetic.invalid',
      identityState: identity,
      tokenProvider: () async {
        tokenReads++;
        final gate = tokenGate;
        tokenGate = null;
        return gate == null ? token : await gate.future;
      },
      client: MockClient((request) async {
        requests.add(request);
        if (request.method == 'GET' &&
            request.url.path == '/api/v1/medicines') {
          await listGate?.future;
          return _json({
            'medicines': [
              if (duplicate)
                {
                  'id': 'existing',
                  'name': 'Existing synthetic medicine',
                  'activeIngredients': ['synthetic-compound'],
                  'leaflet': {'reviewStatus': 'user_confirmed'},
                  'batches': [],
                },
            ],
          });
        }
        if (request.method == 'POST' &&
            request.url.path == '/api/v1/medicines') {
          await createGate?.future;
          afterCreate?.call();
          return _json({
            'id': 'created',
            'name': 'original medicine',
            'batches': [],
          });
        }
        if (request.url.path.endsWith('/leaflet-photos')) {
          await photoGate?.future;
          return _json({
            'photo': {
              'id': 'photo',
              'medicineId': 'created',
              'contentType': 'image/png',
              'sizeBytes': 4,
              'createdAt': '2026-10-03',
              'url': '/synthetic',
            },
          });
        }
        if (request.url.path.endsWith('/cover-photo')) return _json({});
        if (request.method == 'GET' &&
            request.url.path == '/api/v1/medicines/created') {
          return _json({
            'id': 'created',
            'name': 'original medicine',
            'batches': [],
          });
        }
        throw StateError(
          'Unexpected synthetic request ${request.method} ${request.url.path}',
        );
      }),
    );
    repository = ApiMedicineRepository(api: api, localStore: store);
  }
  final raw = _DraftStore();
  late final IdentityLocalStore store;
  late final ApiClient api;
  late final ApiMedicineRepository repository;
  final navigator = GlobalKey<NavigatorState>();
  final requests = <http.Request>[];
  String token = 'synthetic-old';
  int tokenReads = 0;
  bool duplicate = false;
  Completer<String?>? tokenGate;
  Completer<void>? listGate;
  Completer<void>? createGate;
  Completer<void>? photoGate;
  VoidCallback? afterCreate;

  static http.Response _json(Object value) => http.Response(
    jsonEncode(value),
    200,
    headers: {'content-type': 'application/json'},
  );

  Future<void> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(600, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigator,
        home: Scaffold(
          body: FilledButton(
            onPressed: () => navigator.currentState!.push(
              MaterialPageRoute<void>(
                builder: (_) => MedicineEntryApiPage(
                  repository: repository,
                  workflow: ApiWorkflowRepository(api: api),
                  localStore: store,
                ),
              ),
            ),
            child: const Text('Open entry'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open entry'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byType(TextField).first);
    await tester.enterText(find.byType(TextField).first, 'original medicine');
    await tester.pump(const Duration(milliseconds: 250));
  }

  dynamic state(WidgetTester tester) =>
      tester.state(find.byType(MedicineEntryApiPage, skipOffstage: false));
  Future<void> save(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
    await tester.pumpAndSettle();
  }

  Future<void> replacementIdentity() async {
    api.invalidateIdentity();
    token = 'synthetic-new';
    repository.clearSessionSnapshot();
    await store.clearFamilyData();
    await seedReplacement();
  }

  Future<void> seedReplacement() async {
    await store.saveDraft(MedicineDraftQueue.storageKey, _replacementQueue);
    await store.saveDraft(_legacy, _replacementLegacy);
  }

  Future<void> externalRoute(WidgetTester tester) async {
    navigator.currentState!.push(
      MaterialPageRoute<void>(
        builder: (_) => const Scaffold(body: Text('New current route')),
      ),
    );
    await tester.pumpAndSettle();
  }

  void expectReplacement() {
    expect(raw.drafts[MedicineDraftQueue.storageKey], _replacementQueue);
    expect(raw.drafts[_legacy], _replacementLegacy);
  }
}

void main() {
  testWidgets(
    'saved medicine clears its draft and the next entry starts empty',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      f.state(tester).brandController.text = 'synthetic brand';
      f.state(tester).leafletControllers['precautionsSummary'].text =
          'synthetic review';
      await f.save(tester);
      expect(find.byType(MedicineEntryApiPage), findsNothing);
      final creates = f.requests
          .where(
            (request) =>
                request.method == 'POST' &&
                request.url.path.endsWith('/medicines'),
          )
          .toList();
      expect(creates, hasLength(1));
      final payload = jsonDecode(creates.single.body) as Map;
      expect(payload['brand'], 'synthetic brand');
      expect(
        (payload['leaflet'] as Map)['precautionsSummary'],
        'synthetic review',
      );
      expect((payload['leaflet'] as Map)['reviewStatus'], 'unverified');
      expect(await f.store.readDraft(_legacy), isNull);
      expect(await MedicineDraftQueue(f.store).list(), isEmpty);
      await tester.tap(find.text('Open entry'));
      await tester.pumpAndSettle();
      expect(f.state(tester).nameController.text, '');
      expect(f.state(tester).brandController.text, '');
      expect(f.state(tester).leafletControllers['precautionsSummary'].text, '');
      expect(find.text('新建一份草稿'), findsNothing);
    },
  );

  testWidgets(
    'Save cannot dispatch old payload after delayed local draft persistence',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      final gate = f.raw.readGate = Completer<void>();
      await f.save(tester);
      expect(f.requests, isEmpty);
      await f.replacementIdentity();
      gate.complete();
      await tester.pumpAndSettle();
      expect(f.requests, isEmpty);
      f.expectReplacement();
    },
  );

  testWidgets(
    'photo consent cannot transfer an old Save into a replacement identity',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      f.state(tester).expiryImage = _Photo();
      await f.save(tester);
      expect(find.text('保存药盒照片？'), findsOneWidget);
      await f.replacementIdentity();
      await tester.tap(find.text('只保存库存'));
      await tester.pumpAndSettle();
      expect(f.requests, isEmpty);
      f.expectReplacement();
    },
  );

  for (final atDialog in [false, true]) {
    testWidgets(
      'duplicate ingredient ${atDialog ? 'dialog' : 'read'} cannot resume Save under another identity',
      (tester) async {
        final f = _Fixture()..duplicate = atDialog;
        await f.open(tester);
        f.state(tester).ingredientController.text = 'synthetic-compound';
        f.state(tester).ingredientsVerified = true;
        final gate = atDialog ? null : f.listGate = Completer<void>();
        await f.save(tester);
        expect(f.requests, hasLength(1));
        await f.replacementIdentity();
        if (atDialog) {
          await tester.tap(find.text('仍然保存'));
        } else {
          gate!.complete();
        }
        await tester.pumpAndSettle();
        expect(f.requests.where((r) => r.method == 'POST'), isEmpty);
        f.expectReplacement();
      },
    );
  }

  testWidgets(
    'route switch while inventory token loads cancels original dispatch',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      final gate = f.tokenGate = Completer<String?>();
      await f.save(tester);
      expect(f.tokenReads, 1);
      await f.externalRoute(tester);
      gate.complete('synthetic-old');
      await tester.pumpAndSettle();
      expect(f.requests, isEmpty);
      expect(find.text('New current route'), findsOneWidget);
    },
  );

  testWidgets(
    'owner change without an epoch change rejects a successful response before cache or cleanup',
    (tester) async {
      final identity = SessionIdentityState(
        origin: 'https://synthetic.invalid',
        secrets: MemorySecretStore(),
        persistence: MemoryPrivateAtomicState(),
      );
      await identity.initialize();
      await identity.acceptToken(identity.beginLink(), 'synthetic-token');
      await identity.recordOwner(
        expectedGeneration: identity.generation!,
        userId: 'user-a',
        familyId: 'family-a',
        isCurrent: () => true,
      );
      final f = _Fixture(identity: identity);
      await f.open(tester);
      final gate = f.createGate = Completer<void>();
      await f.save(tester);
      await identity.recordOwner(
        expectedGeneration: identity.generation!,
        userId: 'user-a',
        familyId: 'family-b',
        isCurrent: () => true,
      );
      await f.store.clearFamilyData();
      await f.seedReplacement();
      gate.complete();
      await tester.pumpAndSettle();
      expect(f.api.identityEpoch, 0);
      expect(f.repository.medicines, isEmpty);
      expect(f.raw.inventory, isNull);
      f.expectReplacement();
    },
  );

  testWidgets(
    'photo consent owns one Save until cancel, then a later Save works',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      f.state(tester).expiryImage = _Photo();
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, '核对后保存'),
      );
      button.onPressed!();
      button.onPressed!();
      await tester.pumpAndSettle();
      expect(find.text('保存药盒照片？'), findsOneWidget);
      expect(find.byType(AlertDialog, skipOffstage: false), findsOneWidget);
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();
      expect(f.state(tester).saving, isFalse);
      expect(f.requests, isEmpty);
      f.state(tester).expiryImage = null;
      await f.save(tester);
      expect(f.requests, hasLength(1));
      expect(find.byType(MedicineEntryApiPage), findsNothing);
    },
  );

  testWidgets(
    'successful response cannot clear replacement drafts or pop a newer route',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      final gate = f.createGate = Completer<void>();
      await f.save(tester);
      expect(f.requests, hasLength(1));
      await f.externalRoute(tester);
      await f.seedReplacement();
      gate.complete();
      await tester.pumpAndSettle();
      expect(find.text('New current route'), findsOneWidget);
      f.expectReplacement();
      expect(f.repository.medicines, isEmpty);
    },
  );

  testWidgets(
    'identity switch during post-response draft write prevents cleanup',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      final gate = Completer<void>();
      f.afterCreate = () => f.raw.readGate = gate;
      await f.save(tester);
      expect(f.requests, hasLength(1));
      await f.replacementIdentity();
      gate.complete();
      await tester.pumpAndSettle();
      f.expectReplacement();
      expect(find.byType(MedicineEntryApiPage), findsOneWidget);
    },
  );

  testWidgets('photo file await cannot acquire replacement credentials', (
    tester,
  ) async {
    final f = _Fixture();
    await f.open(tester);
    final photo = _Photo();
    f.state(tester).expiryImage = photo;
    await f.save(tester);
    await tester.tap(find.text('确认上传照片'));
    await tester.pumpAndSettle();
    expect(photo.entered.isCompleted, isTrue);
    expect(f.requests, hasLength(1));
    await f.replacementIdentity();
    photo.release.complete(Uint8List.fromList([137, 80, 78, 71]));
    await tester.pumpAndSettle();
    expect(f.requests, hasLength(1));
    expect(f.requests.single.headers['authorization'], 'Bearer synthetic-old');
    f.expectReplacement();
  });

  testWidgets(
    'route switch during photo token await prevents upload dispatch',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      final photo = _Photo();
      f.state(tester).expiryImage = photo;
      await f.save(tester);
      await tester.tap(find.text('确认上传照片'));
      await tester.pumpAndSettle();
      final gate = f.tokenGate = Completer<String?>();
      photo.release.complete(Uint8List.fromList([137, 80, 78, 71]));
      await tester.pumpAndSettle();
      expect(f.tokenReads, 2);
      await f.externalRoute(tester);
      gate.complete('synthetic-old');
      await tester.pumpAndSettle();
      expect(f.requests, hasLength(1));
      expect(find.text('New current route'), findsOneWidget);
    },
  );
  testWidgets('stale photo response cannot remove replacement drafts', (
    tester,
  ) async {
    final f = _Fixture();
    await f.open(tester);
    final photo = _Photo();
    f.state(tester).expiryImage = photo;
    await f.save(tester);
    await tester.tap(find.text('确认上传照片'));
    await tester.pumpAndSettle();
    final gate = f.photoGate = Completer<void>();
    photo.release.complete(Uint8List.fromList([137, 80, 78, 71]));
    await tester.pumpAndSettle();
    expect(f.requests, hasLength(2));
    await f.replacementIdentity();
    gate.complete();
    await tester.pumpAndSettle();
    f.expectReplacement();
    expect(
      f.requests.every(
        (r) => r.headers['authorization'] == 'Bearer synthetic-old',
      ),
      isTrue,
    );
  });

  testWidgets(
    'current inventory plus synthetic photo completes and clears its own draft',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      final photo = _Photo();
      f.state(tester).expiryImage = photo;
      await f.save(tester);
      await tester.tap(find.text('确认上传照片'));
      await tester.pumpAndSettle();
      photo.release.complete(Uint8List.fromList([137, 80, 78, 71]));
      await tester.pumpAndSettle();
      expect(f.requests, hasLength(2));
      expect(find.byType(MedicineEntryApiPage), findsNothing);
      expect(f.raw.drafts[_legacy], isNull);
      expect(jsonDecode(f.raw.drafts[MedicineDraftQueue.storageKey]!), isEmpty);
    },
  );
  for (final initiallyVerified in [false, true]) {
    testWidgets(
      'photo consent retains the original ingredient verification snapshot $initiallyVerified',
      (tester) async {
        final f = _Fixture()..duplicate = true;
        await f.open(tester);
        f.state(tester).expiryImage = _Photo();
        f.state(tester).ingredientController.text = 'synthetic-compound';
        f.state(tester).ingredientsVerified = initiallyVerified;
        await f.save(tester);
        // Simulate a previously started recognition callback during consent.
        // Fill the callback content before binding its confirmation state.
        f.state(tester).ingredientController.text = 'later-result';
        f.state(tester).ingredientsVerified = !initiallyVerified;
        expect(f.state(tester).ingredientsVerified, !initiallyVerified);
        expect(f.state(tester).ingredientController.text, 'later-result');
        await tester.tap(find.text('只保存库存'));
        await tester.pumpAndSettle();
        if (initiallyVerified) {
          expect(find.text('家中已有相同成分记录'), findsOneWidget);
          await tester.tap(find.text('仍然保存'));
          await tester.pumpAndSettle();
        }
        final posts = f.requests.where((r) => r.method == 'POST').toList();
        expect(posts, hasLength(1));
        final body = jsonDecode(posts.single.body) as Map;
        expect(body['activeIngredients'], ['synthetic-compound']);
        expect(
          body['leaflet']['reviewStatus'],
          initiallyVerified ? 'user_confirmed' : 'unverified',
        );
        expect(
          f.requests.where((r) => r.method == 'GET').length,
          initiallyVerified ? 1 : 0,
        );
      },
    );
  }
}
