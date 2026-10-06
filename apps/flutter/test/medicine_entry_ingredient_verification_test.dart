import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/medicine_draft_queue.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_entry_api_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _ingredientLabel = '成分（多个请用逗号分开）';
const _verificationLabel = '已对照包装核对有效成分';

class _Fixture {
  final store = MemoryInventoryLocalStore();
  final requests = <http.Request>[];
  final navigator = GlobalKey<NavigatorState>();
  late final ApiClient api = ApiClient(
    baseUrl: 'https://synthetic.invalid',
    tokenProvider: () async => 'synthetic-token',
    client: MockClient((request) async {
      requests.add(request);
      if (request.url.path == '/api/v1/medicine-catalog/candidates') {
        final result = await catalogGate?.future;
        return _json(
          result ??
              {
                'candidates': [
                  {
                    'name': 'Candidate B',
                    'activeIngredients': ['compound-B'],
                  },
                ],
              },
        );
      }
      if (request.method == 'GET' && request.url.path == '/api/v1/medicines') {
        return _json({'medicines': []});
      }
      if (request.method == 'POST' && request.url.path == '/api/v1/medicines') {
        await createGate?.future;
        return _json({'id': 'created', 'name': 'Synthetic', 'batches': []});
      }
      throw StateError('Unexpected synthetic request: ${request.url.path}');
    }),
  );
  Completer<Map<String, dynamic>>? catalogGate;
  Completer<void>? createGate;

  static http.Response _json(Object data) => http.Response(
    jsonEncode(data),
    200,
    headers: {'content-type': 'application/json'},
  );

  dynamic state(WidgetTester tester) =>
      tester.state(find.byType(MedicineEntryApiPage));

  Future<void> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(700, 1200);
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
                  repository: ApiMedicineRepository(
                    api: api,
                    localStore: store,
                  ),
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
    if (state(tester).nameController.text.isEmpty) {
      await tester.enterText(find.byType(TextField).first, 'Synthetic');
      await tester.pump(const Duration(milliseconds: 250));
    }
    await expand(tester);
  }

  Future<void> expand(WidgetTester tester) async {
    if (!state(tester).moreExpanded) {
      await tester.ensureVisible(find.text('更多资料（选填）'));
      await tester.tap(find.text('更多资料（选填）'));
      await tester.pumpAndSettle();
    }
  }

  Future<void> edit(WidgetTester tester, String value) async {
    final field = find.byWidgetPredicate(
      (w) => w is TextField && w.decoration?.labelText == _ingredientLabel,
    );
    await tester.ensureVisible(field);
    await tester.enterText(field, value);
    await tester.pump(const Duration(milliseconds: 250));
  }

  Future<void> verify(WidgetTester tester) async {
    await tester.ensureVisible(find.text(_verificationLabel));
    await tester.tap(find.text(_verificationLabel));
    await tester.pump(const Duration(milliseconds: 250));
    expect(checked(tester), isTrue);
  }

  bool checked(WidgetTester tester) => tester
      .widget<CheckboxListTile>(
        find.widgetWithText(CheckboxListTile, _verificationLabel),
      )
      .value!;

  Future<void> search(WidgetTester tester) async {
    await tester.ensureVisible(find.text('联网查询候选资料'));
    await tester.tap(find.text('联网查询候选资料'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('同意并查询'));
    await tester.pumpAndSettle();
  }

  Future<void> selectCandidate(WidgetTester tester) async {
    await tester.tap(find.text('Candidate B'));
    await tester.pumpAndSettle();
  }

  Future<Map<String, dynamic>> save(
    WidgetTester tester, {
    bool retry = false,
  }) async {
    await tester.tap(
      find.widgetWithText(FilledButton, retry ? '重试原提交' : '核对后保存'),
    );
    await tester.pumpAndSettle();
    final request = requests.singleWhere(
      (r) => r.method == 'POST' && r.url.path == '/api/v1/medicines',
    );
    return jsonDecode(request.body) as Map<String, dynamic>;
  }

  void expectStatus(
    Map<String, dynamic> payload,
    String ingredient,
    bool verified,
  ) {
    expect(payload['activeIngredients'], [ingredient]);
    expect(
      payload['leaflet']['reviewStatus'],
      verified ? 'user_confirmed' : 'unverified',
    );
    expect(
      requests
          .where((r) => r.method == 'GET' && r.url.path == '/api/v1/medicines')
          .length,
      verified ? 1 : 0,
    );
  }

  Future<void> switchDraft(WidgetTester tester, String name) async {
    await tester.tap(find.byTooltip('本机草稿'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(name));
    await tester.pumpAndSettle();
    await expand(tester);
  }
}

void main() {
  testWidgets('verified A cleared then candidate B saves B as unverified', (
    tester,
  ) async {
    final f = _Fixture();
    await f.open(tester);
    await f.edit(tester, 'compound-A');
    await f.verify(tester);
    await f.edit(tester, '');
    await f.search(tester);
    await f.selectCandidate(tester);
    // Assert the actual outgoing payload, not just a cosmetic checkbox reset.
    f.expectStatus(await f.save(tester), 'compound-B', false);
  });

  testWidgets('manual ingredient replacement invalidates its confirmation', (
    tester,
  ) async {
    final f = _Fixture();
    await f.open(tester);
    await f.edit(tester, 'compound-A');
    await f.verify(tester);
    await f.edit(tester, 'compound-B');
    expect(f.checked(tester), isFalse);
    f.expectStatus(await f.save(tester), 'compound-B', false);
  });

  testWidgets(
    'returning to A after changing content needs explicit reconfirmation',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      await f.edit(tester, 'compound-A');
      await f.verify(tester);
      await f.edit(tester, 'compound-B');
      await f.edit(tester, 'compound-A');
      expect(f.checked(tester), isFalse);
      await f.verify(tester);
      f.expectStatus(await f.save(tester), 'compound-A', true);
    },
  );

  testWidgets(
    'unchanged parsed content and cursor changes preserve confirmation',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      await f.edit(tester, 'compound-A');
      await f.verify(tester);
      await f.edit(tester, ' compound-A， ');
      final TextEditingController controller = f
          .state(tester)
          .ingredientController;
      controller.selection = const TextSelection.collapsed(offset: 1);
      await tester.pump();
      expect(f.checked(tester), isTrue);
      f.expectStatus(await f.save(tester), 'compound-A', true);
    },
  );

  testWidgets('candidate cannot replace nonempty confirmed ingredients', (
    tester,
  ) async {
    final f = _Fixture();
    await f.open(tester);
    await f.edit(tester, 'compound-A');
    await f.verify(tester);
    await f.search(tester);
    await f.selectCandidate(tester);
    expect(f.checked(tester), isTrue);
    f.expectStatus(await f.save(tester), 'compound-A', true);
  });

  testWidgets(
    'candidate ingredients can be explicitly confirmed after selection',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      await f.search(tester);
      await f.selectCandidate(tester);
      await f.verify(tester);
      f.expectStatus(await f.save(tester), 'compound-B', true);
    },
  );

  for (final content in ['', ' ,，、;； ']) {
    testWidgets(
      'empty parsed ingredients cannot acquire a confirmation: $content',
      (tester) async {
        final f = _Fixture();
        await f.open(tester);
        await f.edit(tester, content);
        await tester.ensureVisible(find.text(_verificationLabel));
        await tester.tap(find.text(_verificationLabel));
        await tester.pump();
        expect(f.checked(tester), isFalse);
        final body = await f.save(tester);
        expect(body['activeIngredients'], isEmpty);
        expect(body['leaflet']['reviewStatus'], 'unverified');
      },
    );
  }

  for (final binding in [null, '["compound-A"]', '["compound-B"]']) {
    testWidgets(
      'restored draft accepts only its matching confirmation: $binding',
      (tester) async {
        final f = _Fixture();
        await f.store.saveDraft(
          'medicine-entry',
          jsonEncode({
            'id': 'restored',
            'name': 'Synthetic',
            'ingredients': 'compound-B',
            'ingredientsVerified': true,
            'verifiedIngredientContent': ?binding,
          }),
        );
        await f.open(tester);
        final verified = binding == '["compound-B"]';
        expect(f.checked(tester), verified);
        f.expectStatus(await f.save(tester), 'compound-B', verified);
      },
    );
  }

  testWidgets(
    'confirmation survives persisted draft switch only for its original content',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      await f.edit(tester, 'compound-A');
      await f.verify(tester);
      final originalId = f.state(tester).draftId as String;
      final queue =
          jsonDecode(f.store.drafts[MedicineDraftQueue.storageKey]!) as List;
      final saved = queue.single as Map;
      expect(saved['verifiedIngredientContent'], '["compound-A"]');
      await f.switchDraft(tester, '新建一份草稿');
      expect(f.state(tester).ingredientController.text, isEmpty);
      expect(f.checked(tester), isFalse);
      await f.switchDraft(tester, 'Synthetic');
      expect(f.state(tester).draftId, originalId);
      expect(f.checked(tester), isTrue);
      await f.edit(tester, 'compound-B');
      expect(f.checked(tester), isFalse);
      f.expectStatus(await f.save(tester), 'compound-B', false);
    },
  );

  testWidgets('delayed old catalog response cannot fill a replacement draft', (
    tester,
  ) async {
    final f = _Fixture();
    await f.open(tester);
    f.catalogGate = Completer<Map<String, dynamic>>();
    await f.search(tester);
    await f.switchDraft(tester, '新建一份草稿');
    f.catalogGate!.complete({
      'candidates': [
        {
          'name': 'Candidate B',
          'activeIngredients': ['compound-B'],
        },
      ],
    });
    await tester.pumpAndSettle();
    expect(find.text('选择候选资料'), findsNothing);
    expect(f.state(tester).ingredientController.text, isEmpty);
    expect(f.checked(tester), isFalse);
  });

  testWidgets(
    'delayed response after edit-clear cycle cannot revive old candidate',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      f.catalogGate = Completer<Map<String, dynamic>>();
      await f.search(tester);
      await f.edit(tester, 'compound-A');
      await f.verify(tester);
      await f.edit(tester, '');
      f.catalogGate!.complete({
        'candidates': [
          {
            'name': 'Candidate B',
            'activeIngredients': ['compound-B'],
          },
        ],
      });
      await tester.pumpAndSettle();
      expect(find.text('选择候选资料'), findsNothing);
      expect(f.state(tester).ingredientController.text, isEmpty);
      expect(f.checked(tester), isFalse);
    },
  );

  for (final replacement in [
    'compound-A 10 mg，compound-B',
    'compound-B，compound-A 5 mg',
    'compound-A 5 mg',
  ]) {
    testWidgets(
      'dose, ordering or list changes revoke confirmation: $replacement',
      (tester) async {
        final f = _Fixture();
        await f.open(tester);
        await f.edit(tester, 'compound-A 5 mg，compound-B');
        await f.verify(tester);
        await f.edit(tester, replacement);
        expect(f.checked(tester), isFalse);
        final body = await f.save(tester);
        expect(body['activeIngredients'], replacement.split('，'));
        expect(body['leaflet']['reviewStatus'], 'unverified');
      },
    );
  }

  for (final changedIdentity in [false, true]) {
    testWidgets(
      'open candidate sheet cannot apply after ${changedIdentity ? 'identity' : 'ingredient'} changes',
      (tester) async {
        final f = _Fixture();
        await f.open(tester);
        await f.search(tester);
        expect(find.text('选择候选资料'), findsOneWidget);
        if (changedIdentity) {
          f.api.invalidateIdentity();
        } else {
          // A callback updates the field while the sheet is open, then clears it.
          f.state(tester).ingredientController.text = 'compound-A';
          f.state(tester).ingredientsVerified = true;
          f.state(tester).ingredientController.clear();
        }
        await f.selectCandidate(tester);
        expect(f.state(tester).ingredientController.text, isEmpty);
        expect(f.checked(tester), isFalse);
      },
    );
  }

  testWidgets(
    'catalog response arriving during Save cannot change its frozen request',
    (tester) async {
      final f = _Fixture();
      await f.open(tester);
      await f.edit(tester, 'compound-A');
      await f.verify(tester);
      f.catalogGate = Completer<Map<String, dynamic>>();
      f.createGate = Completer<void>();
      await f.search(tester);
      await tester.tap(find.widgetWithText(FilledButton, '核对后保存'));
      await tester.pumpAndSettle();
      expect(
        f.requests.where(
          (r) => r.method == 'POST' && r.url.path == '/api/v1/medicines',
        ),
        hasLength(1),
      );
      f.catalogGate!.complete({
        'candidates': [
          {
            'name': 'Candidate B',
            'activeIngredients': ['compound-B'],
          },
        ],
      });
      await tester.pumpAndSettle();
      expect(find.text('选择候选资料'), findsNothing);
      f.createGate!.complete();
      await tester.pumpAndSettle();
      final request = f.requests.singleWhere(
        (r) => r.method == 'POST' && r.url.path == '/api/v1/medicines',
      );
      f.expectStatus(
        jsonDecode(request.body) as Map<String, dynamic>,
        'compound-A',
        true,
      );
    },
  );

  testWidgets(
    'legacy uncertain submission retains the exact frozen payload on retry',
    (tester) async {
      final f = _Fixture();
      final frozen = <String, dynamic>{
        'idempotencyKey': 'draft-restored',
        'name': 'Synthetic',
        'activeIngredients': ['compound-B'],
        'leaflet': {'reviewStatus': 'user_confirmed'},
        'batches': [],
      };
      await f.store.saveDraft(
        'medicine-entry',
        jsonEncode({
          'id': 'restored',
          'name': 'Synthetic',
          'ingredients': 'compound-B',
          'ingredientsVerified': true,
          'moreExpanded': true,
          'attemptedPayload': frozen,
        }),
      );
      await f.open(tester);
      expect(f.checked(tester), isFalse);
      // A request may already have committed. Reusing its key with new contents
      // would change the user's original intent rather than resolve its result.
      expect(await f.save(tester, retry: true), frozen);
    },
  );
}
