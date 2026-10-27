import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_detail_api_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _Fixture {
  _Fixture(this.identity, this.api, this.repository, this.writes);
  final SessionIdentityState identity;
  final ApiClient api;
  final ApiMedicineRepository repository;
  final List<Map<String, dynamic>> writes;
  Completer<void>? tokenGate;
  Completer<void>? putGate;

  static Future<_Fixture> create({bool conflict = false}) async {
    final identity = SessionIdentityState(
      origin: 'https://synthetic.invalid',
      secrets: MemorySecretStore(),
      persistence: MemoryPrivateAtomicState(),
    );
    await identity.initialize();
    await identity.acceptToken(identity.beginLink(), 'token');
    await identity.recordOwner(
      expectedGeneration: identity.generation!,
      userId: 'user-a',
      familyId: 'family-a',
      isCurrent: () => true,
    );
    final writes = <Map<String, dynamic>>[];
    late _Fixture fixture;
    final api = ApiClient(
      baseUrl: identity.origin,
      identityState: identity,
      tokenProvider: () async {
        await fixture.tokenGate?.future;
        return identity.readAccessToken();
      },
      client: MockClient((request) async {
        if (request.method == 'PUT') {
          writes.add(jsonDecode(request.body) as Map<String, dynamic>);
          await fixture.putGate?.future;
          if (conflict) {
            return http.Response(
              jsonEncode({
                'error': {'code': 'VERSION_CONFLICT', 'message': '版本冲突'},
              }),
              409,
              headers: {'content-type': 'application/json'},
            );
          }
        }
        final data = request.url.path.endsWith('/dosage-notes')
            ? {'notes': []}
            : {
                'id': 'medicine',
                'name': '合成药',
                'version': 7,
                'brand': '原品牌',
                'specification': '原规格',
                'manufacturer': '原厂家',
                'approvalNumber': '原文号',
                'barcodeValue': '123456',
                'activeIngredients': ['原成分'],
                'purposeTags': ['pain'],
                'populationTags': ['adult'],
                'leaflet': {
                  'purposeSummary': '原用途',
                  'packageUsageSummary': '原用法',
                  'source': 'package',
                  'reviewStatus': 'user_confirmed',
                },
                'batches': [
                  {
                    'id': 'batch',
                    'quantity': 2,
                    'unit': 'box',
                    'version': 4,
                    'expiry': {'value': '2028-01-01', 'precision': 'day'},
                  },
                ],
              };
        return http.Response(
          jsonEncode(data),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    fixture = _Fixture(
      identity,
      api,
      ApiMedicineRepository(api: api, localStore: MemoryInventoryLocalStore()),
      writes,
    );
    return fixture;
  }

  Future<void> open(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: MedicineDetailApiPage(
          repository: repository,
          workflow: ApiWorkflowRepository(api: api),
          medicineId: 'medicine',
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('编辑资料'), findsOneWidget);
    await Scrollable.ensureVisible(
      tester.element(find.text('编辑资料')),
      alignment: .5,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('编辑资料'));
    await tester.pumpAndSettle();
  }
}

Finder _field(String label) => find.byWidgetPredicate(
  (widget) => widget is TextField && widget.decoration?.labelText == label,
);

Future<void> _edit(WidgetTester tester, String label, String value) async {
  await Scrollable.ensureVisible(tester.element(_field(label)), alignment: .5);
  await tester.pumpAndSettle();
  await tester.enterText(_field(label), value);
}

Future<void> _save(WidgetTester tester) async {
  await tester.tap(find.text('保存资料'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'editing preserves version and unrelated data while clearing optional fields',
    (tester) async {
      final f = await _Fixture.create();
      addTearDown(f.api.close);
      await f.open(tester);
      await _edit(tester, '药名', '新药名');
      await _edit(tester, '规格', '');
      await _edit(tester, '成分（多个请用逗号分开）', '新成分');
      await _edit(tester, '功能与用途', '新用途');
      await _save(tester);
      final body = f.writes.single;
      expect(body['name'], '新药名');
      expect(body['specification'], isNull);
      expect(body['version'], 7);
      expect(body['barcodeValue'], '123456');
      expect(body['purposeTags'], ['pain']);
      expect(body['populationTags'], ['adult']);
      expect((body['batches'] as List).single['id'], 'batch');
      expect((body['batches'] as List).single['version'], 4);
      expect(body['activeIngredients'], ['新成分']);
      expect(body['leaflet']['purposeSummary'], '新用途');
      expect(body['leaflet']['reviewStatus'], 'unverified');
    },
  );

  testWidgets('version conflict preserves unsaved input without overwriting', (
    tester,
  ) async {
    final f = await _Fixture.create(conflict: true);
    addTearDown(f.api.close);
    await f.open(tester);
    await _edit(tester, '药名', '尚未保存的药名');
    await _save(tester);
    expect(f.writes.single['version'], 7);
    expect(tester.widget<TextField>(_field('药名')).controller!.text, '尚未保存的药名');
    expect(find.textContaining('版本冲突'), findsWidgets);
  });

  testWidgets('family change during token lookup prevents an old form write', (
    tester,
  ) async {
    final f = await _Fixture.create();
    addTearDown(f.api.close);
    await f.open(tester);
    await _edit(tester, '药名', '旧家庭修改');
    f.tokenGate = Completer<void>();
    await tester.tap(find.text('保存资料'));
    await tester.pump();
    await f.identity.clearFamily();
    f.tokenGate!.complete();
    await tester.pumpAndSettle();
    expect(f.writes, isEmpty);
    expect(find.textContaining('家庭或账号已变化'), findsOneWidget);
    expect(find.text('旧家庭修改'), findsNothing);
  });

  testWidgets('unchanged source keeps its existing review status', (
    tester,
  ) async {
    final f = await _Fixture.create();
    addTearDown(f.api.close);
    await f.open(tester);
    await _save(tester);
    expect(f.writes.single['leaflet']['reviewStatus'], 'user_confirmed');
  });

  testWidgets('late save response cannot repopulate the new family cache', (
    tester,
  ) async {
    final f = await _Fixture.create();
    addTearDown(f.api.close);
    await f.open(tester);
    await _edit(tester, '药名', '旧家庭药名');
    f.putGate = Completer<void>();
    await tester.tap(find.text('保存资料'));
    await tester.pump();
    expect(f.writes.length, 1);
    await f.identity.clearFamily();
    f.repository.clearSessionSnapshot();
    f.putGate!.complete();
    await tester.pumpAndSettle();
    expect(f.repository.medicines, isEmpty);
    expect(find.textContaining('家庭或账号已变化'), findsOneWidget);
    expect(find.text('旧家庭药名'), findsNothing);
  });
}
