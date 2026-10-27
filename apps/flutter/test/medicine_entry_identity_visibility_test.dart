import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:http/testing.dart';

Future<SessionIdentityState> identity() async {
  final result = SessionIdentityState(
    origin: 'https://synthetic.invalid',
    secrets: MemorySecretStore(),
    persistence: MemoryPrivateAtomicState(),
  );
  await result.initialize();
  await result.acceptToken(result.beginLink(), 'synthetic');
  await result.recordOwner(
    expectedGeneration: result.generation!,
    userId: 'user-a',
    familyId: 'family-a',
    isCurrent: () => true,
  );
  return result;
}

void main() {
  testWidgets('draft picker hides old family draft names when family changes', (
    tester,
  ) async {
    final id = await identity();
    final store = MemoryInventoryLocalStore();
    final ownerKey = base64Url.encode(
      utf8.encode(jsonEncode([id.origin, 'user-a', 'family-a'])),
    );
    await MedicineDraftQueue(
      store,
      ownerKey: ownerKey,
    ).save('draft-1', {'name': '旧家庭私有草稿'});
    final api = ApiClient(
      baseUrl: id.origin,
      identityState: id,
      tokenProvider: id.readAccessToken,
      client: MockClient((_) async => throw StateError('no network')),
    );
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        home: MedicineEntryApiPage(
          repository: ApiMedicineRepository(api: api, localStore: store),
          workflow: ApiWorkflowRepository(api: api),
          localStore: store,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('导入草稿'));
    await tester.pumpAndSettle();
    expect(find.text('旧家庭私有草稿'), findsOneWidget);
    await id.recordOwner(
      expectedGeneration: id.generation!,
      userId: 'user-a',
      familyId: 'family-b',
      isCurrent: () => true,
    );
    await tester.pump();
    expect(find.text('旧家庭私有草稿', skipOffstage: false), findsNothing);
    expect(find.text('家庭身份已变化，原资料已隐藏。'), findsOneWidget);
    expect(
      (await MedicineDraftQueue(
        store,
        ownerKey: ownerKey,
      ).list()).single['name'],
      '旧家庭私有草稿',
    );
  });

  testWidgets('date picker hides old family date after identity change', (
    tester,
  ) async {
    final id = await identity();
    final store = MemoryInventoryLocalStore();
    final api = ApiClient(
      baseUrl: id.origin,
      identityState: id,
      tokenProvider: id.readAccessToken,
      client: MockClient((_) async => throw StateError('no network')),
    );
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: const [Locale('zh', 'CN')],
        home: MedicineEntryApiPage(
          repository: ApiMedicineRepository(api: api, localStore: store),
          workflow: ApiWorkflowRepository(api: api),
          localStore: store,
        ),
      ),
    );
    await tester.pumpAndSettle();
    final field = find.byKey(const ValueKey('api-expiry-date-field'));
    await Scrollable.ensureVisible(tester.element(field), alignment: 0.25);
    await tester.pumpAndSettle();
    await tester.tap(field);
    await tester.pumpAndSettle();
    expect(find.byType(CupertinoDatePicker), findsOneWidget);
    id.beginSignOut();
    await tester.pump();
    expect(find.byType(CupertinoDatePicker, skipOffstage: false), findsNothing);
    expect(find.text('家庭身份已变化，日期已隐藏。'), findsOneWidget);
  });

  for (final transition in ['family', 'logout']) {
    testWidgets(
      'entry and local original are hidden immediately after $transition',
      (tester) async {
        final id = await identity();
        final store = MemoryInventoryLocalStore();
        final root = await tester.runAsync(
          () => Directory.systemTemp.createTemp('medicine-private-view-'),
        );
        addTearDown(() async => root!.delete(recursive: true));
        final path = '${root!.path}/synthetic.png';
        await tester.runAsync(
          () => File(path).writeAsBytes(
            base64Decode(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
            ),
          ),
        );
        final ownerKey = base64Url.encode(
          utf8.encode(jsonEncode([id.origin, 'user-a', 'family-a'])),
        );
        await MedicineDraftQueue(store, ownerKey: ownerKey).save(
          'private-draft',
          {
            'name': '旧家庭合成药',
            'photos': [
              {
                'path': path,
                'purpose': 'box_front',
                'state': 'ready',
                'clientPhotoId': 'local-1',
                'sequence': 1,
                'recognitionStatus': 'pending',
              },
            ],
          },
        );
        final api = ApiClient(
          baseUrl: id.origin,
          identityState: id,
          tokenProvider: id.readAccessToken,
          client: MockClient((_) async => throw StateError('no network')),
        );
        addTearDown(api.close);
        await tester.pumpWidget(
          MaterialApp(
            home: MedicineEntryApiPage(
              repository: ApiMedicineRepository(api: api, localStore: store),
              workflow: ApiWorkflowRepository(api: api),
              localStore: store,
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('导入草稿'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('旧家庭合成药'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('逐图核对与来源'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('图1 · 药盒'));
        await tester.pumpAndSettle();
        final view = find.text('查看原图');
        await tester.ensureVisible(view);
        await tester.tap(view);
        await tester.pumpAndSettle();
        expect(find.byType(Image), findsWidgets);
        if (transition == 'family') {
          await id.recordOwner(
            expectedGeneration: id.generation!,
            userId: 'user-a',
            familyId: 'family-b',
            isCurrent: () => true,
          );
        } else {
          id.beginSignOut();
        }
        await tester.pump();
        expect(find.byType(Image, skipOffstage: false), findsNothing);
        expect(find.byType(TextField, skipOffstage: false), findsNothing);
        expect(find.text('原图已隐藏，请重新打开照片资料。'), findsOneWidget);
      },
    );
  }
}
