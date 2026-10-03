import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/data/local_reminder_service.dart';
import 'package:home_medicine_flutter/data/notification_tap_handler.dart';

const occurrence = '11111111-1111-4111-8111-111111111111';
const payload = 'dose-occurrence:v1:2026-12-31:$occurrence';
http.Response response(Object body, [int code = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), code);
Map<String, Object> schedule({bool visible = true}) => {
  'date': '2026-12-31',
  'entries': [
    if (visible)
      {'occurrenceId': occurrence, 'planId': 'private-plan', 'time': '09:00'},
  ],
};
ApiPlanRepository repository(
  Future<http.Response> Function(http.Request) send,
) => ApiPlanRepository(
  api: ApiClient(
    baseUrl: 'https://medicine.example',
    tokenProvider: () async => 'synthetic',
    client: MockClient(send),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('tap uses fresh protected occurrence and detail, never trusts payload as plan id', () async {
    final calls = <String>[];
    final destinations = <String>[];
    var refreshed = 0;
    final repo =
        repository((r) async {
            calls.add(r.url.path);
            expect(r.headers['authorization'], 'Bearer synthetic');
            if (r.url.path.endsWith('/schedule')) {
              expect(r.url.queryParameters, {'date': '2026-12-31'});
              return response(schedule());
            }
            return response({
              'plan': {'id': 'private-plan'},
              'canManage': false,
            });
          })
          ..onChanged = () async {
            refreshed++;
          };
    final handler = NotificationTapHandler(
      repository: repo,
      navigate: destinations.add,
    );
    await handler.handle(payload);
    expect(refreshed, 1);
    expect(calls, [
      '/api/v1/medication-plans/schedule',
      '/api/v1/medication-plans/private-plan',
    ]);
    expect(destinations, ['/plan/private-plan']);
  });

  for (final name in ['receive-only', 'revoked', 'missing', 'superseded']) {
    test(
      '$name occurrence uses authenticated generic plans page and does not fetch detail',
      () async {
        final destinations = <String>[];
        final repo = repository((r) async {
          expect(r.url.path, '/api/v1/medication-plans/schedule');
          return response(schedule(visible: false));
        });
        await NotificationTapHandler(
          repository: repo,
          navigate: destinations.add,
        ).handle(payload);
        expect(destinations, ['/home?tab=plans']);
      },
    );
  }

  for (final code in [403, 404]) {
    test(
      'revocation between schedule and plan detail ($code) fails closed',
      () async {
        final destinations = <String>[];
        final repo = repository(
          (r) async => r.url.path.endsWith('/schedule')
              ? response(schedule())
              : response({
                  'error': {'code': 'FORBIDDEN', 'message': 'denied'},
                }, code),
        );
        await NotificationTapHandler(
          repository: repo,
          navigate: destinations.add,
        ).handle(payload);
        expect(destinations, ['/home?tab=plans']);
      },
    );
  }

  test('legacy and malformed payloads authenticate but never request payload plan IDs', () async {
    for (final legacy in [
      'dose:private-plan',
      'dose:../../secret',
      'dose-occurrence:v1:2026-02-30:$occurrence',
      'dose-occurrence:v1:2026-12-31:not-an-id',
    ]) {
      final destinations = <String>[];
      final repo = repository((r) async {
        expect(r.url.path, '/api/v1/medication-plans/schedule');
        expect(r.url.queryParameters, isEmpty);
        return response(schedule());
      });
      await NotificationTapHandler(
        repository: repo,
        navigate: destinations.add,
      ).handle(legacy);
      expect(destinations, ['/home?tab=plans']);
    }
  });

  test('expired auth, removed family and offline taps have safe distinct destinations', () async {
    for (final entry in [
      (401, 'UNAUTHORIZED', '/connect'),
      (404, 'FAMILY_NOT_FOUND', '/family-choice'),
      (503, 'UNAVAILABLE', '/home?tab=plans'),
    ]) {
      final destinations = <String>[];
      final repo = repository(
        (_) async => response({
          'error': {'code': entry.$2, 'message': 'generic'},
        }, entry.$1),
      );
      await NotificationTapHandler(
        repository: repo,
        navigate: destinations.add,
      ).handle(payload);
      expect(destinations, [entry.$3]);
    }
    final destinations = <String>[];
    final repo = repository((_) async => throw http.ClientException('offline'));
    await NotificationTapHandler(
      repository: repo,
      navigate: destinations.add,
    ).handle(payload);
    expect(destinations, ['/home?tab=plans']);
  });

  test('identity change and disposed handler reject late successful private detail', () async {
    for (final identityChange in [true, false]) {
      final gate = Completer<void>();
      final entered = Completer<void>();
      final destinations = <String>[];
      final repo = repository((r) async {
        if (r.url.path.endsWith('/schedule')) return response(schedule());
        entered.complete();
        await gate.future;
        return response({
          'plan': {'id': 'private-plan'},
        });
      });
      final handler = NotificationTapHandler(
        repository: repo,
        navigate: destinations.add,
      );
      final pending = handler.handle(payload);
      await entered.future;
      if (identityChange) {
        repo.api.invalidateIdentity();
      } else {
        handler.dispose();
      }
      gate.complete();
      await pending;
      expect(destinations, isEmpty);
    }
  });

  test('latest tap wins over a late older navigation', () async {
    final gate = Completer<void>();
    var count = 0;
    final destinations = <String>[];
    final repo = repository((_) async {
      count++;
      if (count == 1) await gate.future;
      return response(schedule(visible: false));
    });
    final handler = NotificationTapHandler(
      repository: repo,
      navigate: destinations.add,
    );
    final first = handler.handle(payload);
    await Future<void>.delayed(Duration.zero);
    await handler.handle('pending');
    gate.complete();
    await first;
    expect(destinations, ['/home?tab=pending']);
  });

  testWidgets(
    'cold buffered tap navigates once, independent of current tab or page lifetime',
    (tester) async {
      final reminders = LocalReminderService();
      reminders.handleNotificationTap(payload);
      var calls = 0;
      final repo = repository((_) async {
        calls++;
        return response(schedule(visible: false));
      });
      final router = GoRouter(
        initialLocation: '/other',
        routes: [
          GoRoute(
            path: '/other',
            builder: (_, _) => const Scaffold(body: Text('Other page')),
          ),
          GoRoute(
            path: '/home',
            builder: (_, state) => Scaffold(
              body: Text('Generic ${state.uri.queryParameters['tab']}'),
            ),
          ),
        ],
      );
      final handler = NotificationTapHandler(
        repository: repo,
        navigate: router.go,
      );
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      reminders.onNotificationTap = (value) => unawaited(handler.handle(value));
      await tester.pumpAndSettle();
      expect(find.text('Generic plans'), findsOneWidget);
      expect(calls, 1);
      reminders.onNotificationTap = (value) => unawaited(handler.handle(value));
      await tester.pumpAndSettle();
      expect(calls, 1);
      router.go('/other');
      await tester.pumpAndSettle();
      reminders.handleNotificationTap('pending');
      await tester.pumpAndSettle();
      expect(find.text('Generic pending'), findsOneWidget);
      handler.dispose();
      router.dispose();
    },
  );
}
