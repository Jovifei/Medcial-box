import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:home_medicine_flutter/core/widgets/app_surfaces.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/plan/plan_form_page.dart';

import 'package:home_medicine_flutter/models/plan_models.dart';

import 'plan_creation_operations_test.dart' show Harness, TestStore, response;

MedicationPlanDraft constDraft() => const MedicationPlanDraft(
  careProfileId: 'profile-a',
  medicineName: 'Original medicine',
  dosageText: 'Original dose',
  timeSlots: ['09:00'],
  weekdays: [],
  startDate: '2026-10-03',
);

Future<GoRouter> open(
  WidgetTester tester,
  Harness h, {
  bool fill = true,
}) async {
  await tester.binding.setSurfaceSize(const Size(900, 1400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const Scaffold(body: Text('Destination')),
        routes: [
          GoRoute(
            path: 'create',
            builder: (_, _) => PlanFormPage(repository: h.repo),
          ),
          GoRoute(
            path: 'new',
            builder: (_, _) => const Scaffold(body: Text('New page')),
          ),
        ],
      ),
    ],
  );
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  router.push('/create');
  await tester.pumpAndSettle();
  if (fill) {
    await tester.enterText(find.byType(TextField).at(0), 'Original medicine');
    await tester.enterText(find.byType(TextField).at(1), 'Original dose');
    await tester.tap(find.text('添加'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
  }
  return router;
}

Future<void> submit(WidgetTester tester) async {
  await tester.tap(find.byType(PrimaryButton));
  await tester.pump();
}

void main() {
  testWidgets(
    'real form restores original uncertain intent across repository restart, explicit retry only',
    (tester) async {
      final store = TestStore();
      final first = Harness(store: store);
      first.onPost = (_) async =>
          throw http.ClientException('synthetic response lost');
      final router = await open(tester, first);
      await submit(tester);
      await tester.pumpAndSettle();
      expect(first.posts.length, 1);
      expect(find.text('重试原计划'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField).first).enabled,
        false,
      );
      router.pop();
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      router.dispose();
      final restarted = Harness(store: store);
      final nextRouter = await open(tester, restarted, fill: false);
      expect(find.text('Original medicine'), findsOneWidget);
      expect(find.text('Original dose'), findsOneWidget);
      expect(restarted.posts, isEmpty);
      await submit(tester);
      await tester.pumpAndSettle();
      expect(restarted.posts.single, first.posts.single);
      expect(find.text('Destination'), findsOneWidget);
      nextRouter.dispose();
    },
  );
  testWidgets(
    'closing during intent storage prevents old HTTP; reopening requires explicit retry',
    (tester) async {
      final store = TestStore();
      final h = Harness(store: store);
      final router = await open(tester, h);
      store.saveGate = Completer<void>();
      await submit(tester);
      await tester.pump();
      router.pop();
      await tester.pumpAndSettle();
      store.saveGate!.complete();
      await tester.pumpAndSettle();
      expect(h.posts, isEmpty);
      router.push('/create');
      await tester.pumpAndSettle();
      expect(find.text('重试原计划'), findsOneWidget);
      expect(h.posts, isEmpty);
      await submit(tester);
      await tester.pumpAndSettle();
      expect(h.posts.length, 1);
      expect(find.text('Destination'), findsOneWidget);
      router.dispose();
    },
  );
  testWidgets('closing during final token lookup prevents old HTTP', (
    tester,
  ) async {
    Completer<String?>? tokenGate;
    final h = Harness(
      tokenProvider: () => tokenGate?.future ?? Future.value('synthetic'),
    );
    final router = await open(tester, h);
    tokenGate = Completer<String?>();
    await submit(tester);
    await tester.pump();
    router.pop();
    await tester.pumpAndSettle();
    tokenGate.complete('synthetic');
    await tester.pumpAndSettle();
    expect(h.posts, isEmpty);
    expect(find.text('Destination'), findsOneWidget);
    router.dispose();
  });
  testWidgets(
    'family switch while saving clears late private intent and cannot navigate replacement page',
    (tester) async {
      final store = TestStore();
      final local = IdentityLocalStore(store);
      final h = Harness(store: local);
      final router = await open(tester, h);
      store.saveGate = Completer<void>();
      await submit(tester);
      await tester.pump();
      h.api.invalidateIdentity();
      final cleanup = local.clearFamilyData();
      router.go('/new');
      await tester.pumpAndSettle();
      store.saveGate!.complete();
      await tester.pumpAndSettle();
      await cleanup;
      expect(h.posts, isEmpty);
      expect(store.drafts, isEmpty);
      expect(find.text('New page'), findsOneWidget);
      expect(find.text('计划已创建'), findsNothing);
      router.dispose();
    },
  );
  testWidgets('late successful HTTP keeps ACK but never pops a newer page', (
    tester,
  ) async {
    final h = Harness();
    final gate = Completer<http.Response>();
    h.onPost = (_) => gate.future;
    var acknowledged = 0;
    h.repo.onMutationAcknowledged = (_) async {
      acknowledged++;
    };
    final router = await open(tester, h);
    await submit(tester);
    await tester.pump();
    expect(h.posts.length, 1);
    router.go('/new');
    await tester.pumpAndSettle();
    gate.complete(
      response({
        'planId': 'plan-a',
        'careProfileId': 'profile-a',
        'status': 'active',
        'version': 1,
      }, 201),
    );
    await tester.pumpAndSettle();
    expect(acknowledged, 1);
    expect(find.text('New page'), findsOneWidget);
    expect(find.text('计划已创建'), findsNothing);
    expect(h.local is TestStore ? (h.local as TestStore).drafts : {}, isEmpty);
    router.dispose();
  });
  testWidgets('rapid repeated taps dispatch a single request', (tester) async {
    final h = Harness();
    final gate = Completer<http.Response>();
    h.onPost = (_) => gate.future;
    final router = await open(tester, h);
    await submit(tester);
    await submit(tester);
    await tester.pump();
    expect(h.posts.length, 1);
    gate.complete(
      response({
        'planId': 'plan-a',
        'careProfileId': 'profile-a',
        'status': 'active',
        'version': 1,
      }, 201),
    );
    await tester.pumpAndSettle();
    expect(find.text('Destination'), findsOneWidget);
    router.dispose();
  });
  testWidgets(
    'definite initial rejection allows correction with a fresh operation key',
    (tester) async {
      final h = Harness();
      h.onPost = (_) async => response({
        'error': {'code': 'INVALID_INPUT', 'message': 'Synthetic rejection'},
      }, 400);
      final router = await open(tester, h);
      await submit(tester);
      await tester.pumpAndSettle();
      expect(find.text('创建计划'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField).first).enabled,
        true,
      );
      await tester.enterText(
        find.byType(TextField).first,
        'Corrected medicine',
      );
      h.onPost = null;
      await submit(tester);
      await tester.pumpAndSettle();
      expect(h.posts[1]['medicineName'], 'Corrected medicine');
      expect(h.posts[1]['idempotencyKey'], isNot(h.posts[0]['idempotencyKey']));
      expect(find.text('Destination'), findsOneWidget);
      router.dispose();
    },
  );
  testWidgets(
    'failed storage read disables create and reload does not replay',
    (tester) async {
      final store = TestStore()..failRead = true;
      final h = Harness(store: store);
      final router = await open(tester, h, fill: false);
      await submit(tester);
      await tester.pumpAndSettle();
      expect(h.posts, isEmpty);
      store.failRead = false;
      await tester.tap(find.text('重新读取'));
      await tester.pumpAndSettle();
      expect(h.posts, isEmpty);
      expect(
        tester.widget<TextField>(find.byType(TextField).first).enabled,
        true,
      );
      router.dispose();
    },
  );
  testWidgets(
    'covered form acknowledged success is visible on return without a new POST',
    (tester) async {
      final h = Harness();
      final gate = Completer<http.Response>();
      h.onPost = (_) => gate.future;
      final router = await open(tester, h);
      await submit(tester);
      await tester.pump();
      router.push('/new');
      await tester.pumpAndSettle();
      gate.complete(
        response({
          'planId': 'plan-a',
          'careProfileId': 'profile-a',
          'status': 'active',
          'version': 1,
        }, 201),
      );
      await tester.pumpAndSettle();
      expect(find.text('New page'), findsOneWidget);
      expect(find.text('计划已创建'), findsNothing);
      router.pop();
      await tester.pumpAndSettle();
      expect(find.text('计划已创建，返回列表'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField).first).enabled,
        false,
      );
      await submit(tester);
      await tester.pumpAndSettle();
      expect(find.text('Destination'), findsOneWidget);
      expect(h.posts.length, 1);
      router.dispose();
    },
  );
  testWidgets(
    'covered form failure cannot show a snackbar on the newer route',
    (tester) async {
      final h = Harness();
      final gate = Completer<http.Response>();
      h.onPost = (_) => gate.future;
      final router = await open(tester, h);
      await submit(tester);
      await tester.pump();
      router.push('/new');
      await tester.pumpAndSettle();
      gate.complete(
        response({
          'error': {'code': 'SERVER_ERROR', 'message': 'Old form failure'},
        }, 503),
      );
      await tester.pumpAndSettle();
      expect(find.text('Old form failure'), findsNothing);
      router.pop();
      await tester.pumpAndSettle();
      expect(find.text('重试原计划'), findsOneWidget);
      router.dispose();
    },
  );
  testWidgets('slow passive refresh never leaves acknowledged form saving', (
    tester,
  ) async {
    final h = Harness();
    final refresh = Completer<void>();
    h.repo.onChanged = () => refresh.future;
    final router = await open(tester, h);
    await submit(tester);
    await tester.pumpAndSettle();
    expect(find.text('Destination'), findsOneWidget);
    expect(find.text('计划已创建'), findsOneWidget);
    refresh.complete();
    await tester.pumpAndSettle();
    router.dispose();
  });
  testWidgets(
    'orphan recovery inspection and confirmation are separate; cancel/remount retain marker',
    (tester) async {
      final store = TestStore();
      final seed = Harness(store: store);
      seed.onPost = (_) async => throw http.ClientException('lost');
      try {
        await seed.repo.createPlan(constDraft());
      } catch (_) {}
      final originalKey = seed.posts.single['idempotencyKey'];
      await store.clearFamilyData();
      final h = Harness(store: store);
      final router = await open(tester, h, fill: false);
      expect(find.text('查看已有计划'), findsOneWidget);
      await tester.tap(find.text('查看已有计划'));
      await tester.pumpAndSettle();
      expect(find.text('核对已有计划'), findsOneWidget);
      expect(find.text('确认开始新计划'), findsNothing);
      await tester.tap(find.text('已核对，继续'));
      await tester.pumpAndSettle();
      expect(find.textContaining('也可能稍后完成'), findsOneWidget);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(store.planCreationMarkers.values.single, originalKey);
      expect(h.posts, isEmpty);
      router.pop();
      await tester.pumpAndSettle();
      router.push('/create');
      await tester.pumpAndSettle();
      expect(find.text('查看已有计划'), findsOneWidget);
      await tester.tap(find.text('查看已有计划'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('已核对，继续'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认开始新计划'));
      await tester.pumpAndSettle();
      expect(store.planCreationMarkers, isEmpty);
      expect(h.posts, isEmpty);
      expect(
        tester.widget<TextField>(find.byType(TextField).first).enabled,
        true,
      );
      router.dispose();
    },
  );
  testWidgets(
    'failed recovery list cannot reach confirmation or retire marker',
    (tester) async {
      final store = TestStore();
      final seed = Harness(store: store);
      seed.onPost = (_) async => throw http.ClientException('lost');
      try {
        await seed.repo.createPlan(constDraft());
      } catch (_) {}
      await store.clearFamilyData();
      final h = Harness(store: store)
        ..planListResponse = response({
          'error': {'code': 'OFFLINE'},
        }, 503);
      final router = await open(tester, h, fill: false);
      await tester.tap(find.text('查看已有计划'));
      await tester.pumpAndSettle();
      expect(find.text('确认开始新计划'), findsNothing);
      expect(store.planCreationMarkers.length, 1);
      expect(h.posts, isEmpty);
      router.dispose();
    },
  );
}
