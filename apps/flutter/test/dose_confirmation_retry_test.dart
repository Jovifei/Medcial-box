import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/core/widgets/app_surfaces.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/data/dose_confirmation_operations.dart';
import 'package:home_medicine_flutter/features/plan/plans_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class DoseServer {
  String date = '2026-10-03';
  String id = 'occ-1';
  String status = 'pending';
  bool loseFirstResponse = true;
  bool failRead = false;
  bool delayFirstCommit = false;
  VoidCallback? lateCommit;
  Completer<void>? gate;
  final requests = <Map<String, dynamic>>[];
  final events = <String, String>{};
  late final api = ApiClient(
    baseUrl: 'https://medicine.example',
    tokenProvider: () async => 'synthetic',
    client: MockClient((request) async {
      if (request.method == 'POST') {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        requests.add(body);
        final key = body['idempotencyKey'] as String;
        void accept() {
          if (events.containsKey(key)) return;
          events[key] = body['action'] as String;
          status = body['action'] as String;
        }

        if (requests.length == 1 && delayFirstCommit) {
          lateCommit = accept;
          throw http.ClientException('server still running');
        }
        await gate?.future;
        accept();
        if (requests.length == 1 && loseFirstResponse) {
          throw http.ClientException('accepted, response lost');
        }
        return response({'status': status});
      }
      if (request.url.path.endsWith('/schedule')) {
        if (failRead) throw http.ClientException('read failed');
        return response({
          'date': date,
          'entries': [
            {
              'occurrenceId': id,
              'planId': 'plan',
              'careProfileId': 'profile',
              'careProfileName': '合成对象',
              'medicineName': '合成药品',
              'dosageText': '测试记录',
              'time': '08:00',
              'status': status,
            },
          ],
        });
      }
      return response({'plans': []});
    }),
  );
  late final repository = ApiPlanRepository(api: api);
  static http.Response response(Object json) =>
      http.Response.bytes(utf8.encode(jsonEncode(json)), 200);
}

Finder actionButton(String label) => find.widgetWithText(SoftButton, label);
Future<void> mount(WidgetTester tester, DoseServer server) async {
  await tester.pumpWidget(
    MaterialApp(home: PlansPage(repository: server.repository)),
  );
  await tester.pumpAndSettle();
}

Future<void> tapAction(WidgetTester tester, String label) async {
  await tester.tap(actionButton(label));
  await tester.pumpAndSettle();
}

Future<void> reload(WidgetTester tester) async {
  await tester
      .widget<RefreshIndicator>(find.byType(RefreshIndicator))
      .onRefresh();
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'accepted plus lost response waits for explicit retry, same key one event',
    (tester) async {
      final server = DoseServer();
      await mount(tester, server);
      await tapAction(tester, '已服用');
      await tester.pump(const Duration(seconds: 30));
      expect(server.requests, hasLength(1));
      await tapAction(tester, '已服用');
      expect(server.requests, hasLength(2));
      expect(
        server.requests[1]['idempotencyKey'],
        server.requests[0]['idempotencyKey'],
      );
      expect(server.events, hasLength(1));
    },
  );

  testWidgets(
    'opposite action cannot overtake an uncertain delayed server commit',
    (tester) async {
      final server = DoseServer()..delayFirstCommit = true;
      await mount(tester, server);
      await tapAction(tester, '已服用');
      await tapAction(tester, '跳过');
      expect(server.requests, hasLength(1));
      expect(find.textContaining('请先重试上次记录'), findsOneWidget);
      server.lateCommit!();
      await tapAction(tester, '已服用');
      expect(server.events, hasLength(1));
      expect(server.status, 'taken');
    },
  );

  testWidgets(
    'remount and authoritative read retain explicit retry after accepted state appears',
    (tester) async {
      final server = DoseServer();
      await mount(tester, server);
      await tapAction(tester, '已服用');
      await tester.pumpWidget(const SizedBox());
      await mount(tester, server);
      expect(server.requests, hasLength(1));
      await tapAction(tester, '重试上次记录');
      expect(
        server.requests[1]['idempotencyKey'],
        server.requests[0]['idempotencyKey'],
      );
      expect(server.events, hasLength(1));
      expect(actionButton('重试上次记录'), findsNothing);
    },
  );

  testWidgets(
    'double taps are locked while request pending, including remount',
    (tester) async {
      final server = DoseServer()
        ..loseFirstResponse = false
        ..gate = Completer<void>();
      await mount(tester, server);
      final callback = tester
          .widget<SoftButton>(actionButton('已服用'))
          .onPressed!;
      callback();
      callback();
      await tester.pump();
      expect(server.requests, hasLength(1));
      await tester.pumpWidget(const SizedBox());
      await mount(tester, server);
      final skip = tester.widget<SoftButton>(actionButton('跳过'));
      expect(skip.onPressed, isNull);
      server.gate!.complete();
      await tester.pumpAndSettle();
      expect(server.requests, hasLength(1));
      expect(find.text('已服用'), findsWidgets);
    },
  );

  testWidgets(
    'identity switch blocks stale visible entry and fresh identity gets fresh key',
    (tester) async {
      final server = DoseServer();
      await mount(tester, server);
      await tapAction(tester, '已服用');
      server.api.invalidateIdentity();
      await tapAction(tester, '已服用');
      expect(server.requests, hasLength(1));
      server.status = 'pending';
      await reload(tester);
      await tapAction(tester, '已服用');
      expect(server.requests, hasLength(2));
      expect(
        server.requests[1]['idempotencyKey'],
        isNot(server.requests[0]['idempotencyKey']),
      );
    },
  );

  testWidgets('new server date and occurrence receive a new operation key', (
    tester,
  ) async {
    final server = DoseServer();
    await mount(tester, server);
    await tapAction(tester, '已服用');
    server.date = '2026-10-04';
    server.id = 'occ-2';
    server.status = 'pending';
    await reload(tester);
    await tapAction(tester, '已服用');
    expect(
      server.requests[1]['idempotencyKey'],
      isNot(server.requests[0]['idempotencyKey']),
    );
    expect(server.events, hasLength(2));
  });

  testWidgets(
    'acknowledged write survives failed refresh and notification callback without replay',
    (tester) async {
      final server = DoseServer()..loseFirstResponse = false;
      await mount(tester, server);
      server.failRead = true;
      server.repository.onChanged = () async {
        throw StateError('notification sync failed');
      };
      await tapAction(tester, '已服用');
      expect(server.events, hasLength(1));
      expect(
        DoseConfirmationOperations.forClient(server.api)
            .pendingFor(server.id, server.date),
        isNull,
      );
      expect(actionButton('已服用'), findsNothing);
      expect(actionButton('重试上次记录'), findsNothing);
      expect(find.textContaining('记录已保存，但后续同步未完成'), findsOneWidget);
      await reload(tester);
      expect(server.requests, hasLength(1));
    },
  );

  testWidgets(
    'changing repository removes old private schedule and retry identity',
    (tester) async {
      final first = DoseServer();
      await mount(tester, first);
      await tapAction(tester, '已服用');
      final second = DoseServer()..id = 'occ-2';
      await mount(tester, second);
      await tapAction(tester, '已服用');
      expect(first.requests, hasLength(1));
      expect(second.requests, hasLength(1));
      expect(
        first.requests.single['idempotencyKey'],
        isNot(second.requests.single['idempotencyKey']),
      );
    },
  );

  testWidgets(
    'replay preserves another authorized correction using acknowledged current status',
    (tester) async {
      final server = DoseServer();
      await mount(tester, server);
      await tapAction(tester, '已服用');
      server.status = 'skipped';
      server.failRead = true;
      await tapAction(tester, '已服用');
      expect(server.events, hasLength(1));
      expect(find.text('已跳过'), findsOneWidget);
      expect(actionButton('已服用'), findsNothing);
      expect(actionButton('重试上次记录'), findsNothing);
    },
  );

  testWidgets(
    'stale callback cannot confirm old occurrence after server date changes',
    (tester) async {
      final server = DoseServer();
      await mount(tester, server);
      final stale = tester.widget<SoftButton>(actionButton('已服用')).onPressed!;
      server.date = '2026-10-04';
      server.id = 'occ-2';
      await reload(tester);
      stale();
      await tester.pumpAndSettle();
      expect(server.requests, isEmpty);
      await tapAction(tester, '已服用');
      expect(server.requests, hasLength(1));
    },
  );

  test(
    'identity change during deferred token lookup never sends stale write',
    () async {
      final token = Completer<String?>();
      var requests = 0;
      final api = ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () => token.future,
        client: MockClient((request) async {
          requests++;
          return DoseServer.response({'status': 'taken'});
        }),
      );
      final repository = ApiPlanRepository(api: api);
      final write = repository.confirmDose(
        'old-occurrence',
        action: 'taken',
        idempotencyKey: 'old-operation',
      );
      api.invalidateIdentity();
      token.complete('new-session');
      await expectLater(
        write,
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'STALE_SESSION'),
        ),
      );
      expect(requests, 0);
      // Device-link/login requests intentionally remain unauthenticated.
      await api.post('/api/v1/app-auth/device-links', authenticated: false);
      expect(requests, 1);
    },
  );

  test('shared helper guards unresolved action/date, fresh corrections and identity changes', () {
    final server = DoseServer();
    final ops = DoseConfirmationOperations.forClient(server.api);
    var changes = 0;
    ops.addListener(() => changes++);
    DoseConfirmationAttempt? begin(
      String action, [
      String date = '2026-10-03',
    ]) => ops.begin(occurrenceId: 'occ', date: date, action: action);
    final first = begin('taken')!;
    expect(begin('taken'), isNull);
    expect(ops.isBusy('occ', first.date), isTrue);
    ops.release(first);
    expect(() => begin('skipped'), throwsA(isA<UnresolvedDoseConfirmation>()));
    expect(
      () => begin('taken', '2026-10-04'),
      throwsA(isA<UnresolvedDoseConfirmation>()),
    );
    expect(begin('taken'), same(first));
    ops.complete(first);
    final correction = begin('skipped')!;
    ops.complete(correction);
    final back = begin('taken')!;
    expect({first.key, correction.key, back.key}, hasLength(3));
    ops.release(back);
    server.api.invalidateIdentity();
    expect(ops.pendingFor('occ', back.date), isNull);
    final newIdentity = begin('taken')!;
    ops.release(back);
    ops.complete(back);
    expect(ops.isBusy('occ', newIdentity.date), isTrue);
    expect(newIdentity.key, isNot(back.key));
    expect(changes, greaterThan(5));
  });
}
