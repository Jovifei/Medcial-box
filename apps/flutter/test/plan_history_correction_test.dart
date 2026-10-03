import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/features/plan/plan_history_page.dart';

class _HistoryServer {
  _HistoryServer({this.canManage = true, this.status = 'taken'}) {
    api = ApiClient(
      baseUrl: 'https://medicine.example',
      tokenProvider: () async => 'test-session',
      client: MockClient(_respond),
    );
    repository = ApiPlanRepository(api: api);
    events.add(_event(status, 'Original recorder', '2026-10-01 09:01'));
  }

  final bool canManage;
  String status;
  bool superseded = false;
  bool permissionFails = false;
  bool historyFails = false;
  bool loseNextAcceptedResponse = false;
  String? rejectCode;
  int historyReads = 0;
  int detailReads = 0;
  final events = <Map<String, Object?>>[];
  final posts = <Map<String, dynamic>>[];
  final acceptedKeys = <String>{};
  Completer<void>? postGate;
  Completer<void>? historyGate;
  late final ApiClient api;
  late final ApiPlanRepository repository;

  Map<String, Object?> _event(String action, String actor, String at) => {
    'action': action,
    'actor': actor,
    'at': at,
  };

  http.Response _json(Object value, [int statusCode = 200]) =>
      http.Response.bytes(
        utf8.encode(jsonEncode(value)),
        statusCode,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );

  http.Response _error(String code, String message, int statusCode) => _json({
    'error': {'code': code, 'message': message},
  }, statusCode);

  Future<http.Response> _respond(http.Request request) async {
    if (request.method == 'POST') {
      expect(
        request.url.path,
        '/api/v1/dose-occurrences/original-occurrence/confirm',
      );
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      posts.add(body);
      if (postGate != null) await postGate!.future;
      if (rejectCode != null) {
        if (rejectCode == 'OCCURRENCE_SUPERSEDED') superseded = true;
        return _error(
          rejectCode!,
          rejectCode == 'FORBIDDEN'
              ? '没有确认该服药安排的权限'
              : '该安排已因计划调整失效，请刷新后按最新安排确认',
          rejectCode == 'FORBIDDEN' ? 403 : 409,
        );
      }
      final replayed = !acceptedKeys.add(body['idempotencyKey'] as String);
      if (!replayed) {
        status = body['action'] as String;
        events.add(_event(status, 'Correcting member', '2026-10-03 09:12'));
      }
      if (loseNextAcceptedResponse) {
        loseNextAcceptedResponse = false;
        throw http.ClientException('accepted response lost');
      }
      return _json({
        'occurrenceId': 'original-occurrence',
        'status': status,
        'replayed': replayed,
      });
    }
    if (request.url.path.endsWith('/history')) {
      historyReads++;
      if (historyFails) return _error('UNAVAILABLE', '历史暂时无法加载', 503);
      final response = _json({
        'planId': 'plan',
        'medicineName': 'Current plan medicine',
        'history': [
          {
            'occurrenceId': 'original-occurrence',
            'date': '2026-10-01',
            'time': '09:00',
            'medicineName': 'Original medicine',
            'dosageText': 'Original user-written dose',
            'snapshotComplete': true,
            'status': status,
            'superseded': superseded,
            'corrected': events.length > 1,
            'events': events,
          },
        ],
      });
      if (historyGate != null) await historyGate!.future;
      return response;
    }
    expect(request.url.path, '/api/v1/medication-plans/plan');
    detailReads++;
    if (permissionFails) return _error('FORBIDDEN', '权限暂时无法核对', 403);
    return _json({
      'plan': {
        'id': 'plan',
        'medicineName': 'Current plan medicine',
        'dosageText': 'New dose',
        'status': 'ended',
      },
      'canManage': canManage,
    });
  }
}

Future<void> _mount(
  WidgetTester tester,
  _HistoryServer server, {
  Key? key,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: PlanHistoryPage(
        key: key,
        repository: server.repository,
        planId: 'plan',
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _openCorrection(
  WidgetTester tester, {
  String action = 'skipped',
}) async {
  final label = action == 'skipped' ? '纠正为已跳过' : '纠正为已服用';
  await tester.ensureVisible(find.text(label));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
  expect(find.byType(AlertDialog), findsOneWidget);
}

Future<void> _submitDialog(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(FilledButton, '确认纠正'));
  await tester.pump();
}

void main() {
  for (final initial in ['taken', 'skipped']) {
    testWidgets(
      'selected $initial correction requires explicit confirmation and cancel writes nothing',
      (tester) async {
        final server = _HistoryServer(status: initial);
        await _mount(tester, server);
        expect(server.detailReads, 1);
        await _openCorrection(
          tester,
          action: initial == 'taken' ? 'skipped' : 'taken',
        );
        final dialog = find.byType(AlertDialog);
        expect(
          find.descendant(
            of: dialog,
            matching: find.textContaining('2026-10-01 09:00'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: dialog,
            matching: find.textContaining('Original medicine'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: dialog,
            matching: find.textContaining('原记录和剂量快照会保留'),
          ),
          findsOneWidget,
        );
        expect(server.posts, isEmpty);
        await tester.tap(find.text('取消'));
        await tester.pumpAndSettle();
        expect(server.posts, isEmpty);
        expect(find.byType(AlertDialog), findsNothing);
      },
    );
  }

  testWidgets(
    'confirmed correction appends one event and refreshes preserved snapshots after duplicate taps',
    (tester) async {
      final server = _HistoryServer()..postGate = Completer<void>();
      await _mount(tester, server);
      // Two taps before rebuilding must open only one confirmation.
      final repeatedAction = tester
          .widget<OutlinedButton>(find.widgetWithText(OutlinedButton, '纠正为已跳过'))
          .onPressed!;
      await tester.tap(find.text('纠正为已跳过'));
      repeatedAction();
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      final repeatedConfirm = tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '确认纠正'))
          .onPressed!;
      await _submitDialog(tester);
      repeatedConfirm();
      await tester.pump();
      expect(server.posts, hasLength(1));
      expect(server.posts.single['action'], 'skipped');
      expect(server.posts.single['idempotencyKey'], isNotEmpty);
      final disabled = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '纠正为已跳过'),
      );
      expect(disabled.onPressed, isNull);
      server.postGate!.complete();
      await tester.pumpAndSettle();
      expect(server.historyReads, 2);
      expect(server.events, hasLength(2));
      expect(
        find.text('Original medicine · Original user-written dose'),
        findsOneWidget,
      );
      expect(find.textContaining('Original recorder'), findsOneWidget);
      expect(find.textContaining('Correcting member'), findsOneWidget);
      expect(find.text('该记录曾被纠正'), findsOneWidget);
      expect(find.text('纠正为已服用'), findsOneWidget);
      expect(find.textContaining('New dose'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a later opposite correction gets a fresh key and keeps both prior events',
    (tester) async {
      final server = _HistoryServer();
      await _mount(tester, server);
      await _openCorrection(tester);
      await _submitDialog(tester);
      await tester.pumpAndSettle();
      await _openCorrection(tester, action: 'taken');
      await _submitDialog(tester);
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(2));
      expect(
        server.posts.last['idempotencyKey'],
        isNot(server.posts.first['idempotencyKey']),
      );
      expect(server.events.map((event) => event['action']), [
        'taken',
        'skipped',
        'taken',
      ]);
      expect(find.textContaining('Original recorder'), findsOneWidget);
      expect(find.textContaining('Correcting member'), findsNWidgets(2));
      expect(
        find.text('Original medicine · Original user-written dose'),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'a late write response from an old identity cannot restore its history',
    (tester) async {
      final server = _HistoryServer()..postGate = Completer<void>();
      await _mount(tester, server);
      await _openCorrection(tester);
      await _submitDialog(tester);
      await tester.pump();
      server.api.invalidateIdentity();
      server.postGate!.complete();
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
      expect(
        find.text('Original medicine · Original user-written dose'),
        findsNothing,
      );
      expect(find.text('纠正已保存'), findsNothing);
      expect(find.text('重试原纠正'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'history correction and confirmation fit narrow screens with large text',
    (tester) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final server = _HistoryServer();
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(2)),
            child: child!,
          ),
          home: PlanHistoryPage(repository: server.repository, planId: 'plan'),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await _openCorrection(tester);
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(find.text('取消'));
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(server.posts, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'read-only access keeps history visible and provides no correction',
    (tester) async {
      final server = _HistoryServer(canManage: false);
      await _mount(tester, server);
      expect(
        find.text('Original medicine · Original user-written dose'),
        findsOneWidget,
      );
      expect(find.text('你对此计划只有查看权限。'), findsOneWidget);
      expect(find.text('纠正为已跳过'), findsNothing);
      expect(server.posts, isEmpty);
    },
  );

  testWidgets(
    'failed permission lookup fails closed without losing readable history',
    (tester) async {
      final server = _HistoryServer()..permissionFails = true;
      await _mount(tester, server);
      expect(
        find.text('Original medicine · Original user-written dose'),
        findsOneWidget,
      );
      expect(find.textContaining('暂时无法核对管理权限'), findsOneWidget);
      expect(find.text('纠正为已跳过'), findsNothing);
      expect(server.posts, isEmpty);
    },
  );

  testWidgets('superseded and unconfirmed history cannot start corrections', (
    tester,
  ) async {
    final server = _HistoryServer()..superseded = true;
    await _mount(tester, server);
    expect(find.text('已因改期作废'), findsOneWidget);
    expect(find.text('纠正为已跳过'), findsNothing);
    server.superseded = false;
    server.status = 'pending';
    await _mount(tester, server, key: const ValueKey('pending'));
    expect(find.text('未确认'), findsOneWidget);
    expect(find.text('纠正为已跳过'), findsNothing);
    expect(find.text('纠正为已服用'), findsNothing);
  });

  for (final code in ['FORBIDDEN', 'OCCURRENCE_SUPERSEDED']) {
    testWidgets(
      '$code rejects correction without optimistic success and reloads authoritative state',
      (tester) async {
        final server = _HistoryServer()..rejectCode = code;
        await _mount(tester, server);
        await _openCorrection(tester);
        await _submitDialog(tester);
        await tester.pumpAndSettle();
        expect(server.posts, hasLength(1));
        expect(server.events, hasLength(1));
        expect(server.historyReads, greaterThanOrEqualTo(2));
        expect(
          find.textContaining(
            code == 'FORBIDDEN' ? '没有确认该服药安排的权限' : '该安排已因计划调整失效',
          ),
          findsWidgets,
        );
        expect(find.text('纠正已保存'), findsNothing);
        expect(find.text('重试原纠正'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'accepted lost response requires explicit same-key retry even after history refresh',
    (tester) async {
      final server = _HistoryServer()..loseNextAcceptedResponse = true;
      await _mount(tester, server);
      await _openCorrection(tester);
      await _submitDialog(tester);
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
      expect(server.events, hasLength(2));
      expect(find.text('重试原纠正'), findsOneWidget);
      await tester.tap(find.byTooltip('刷新历史'));
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
      expect(find.text('重试原纠正'), findsOneWidget);
      expect(find.text('纠正为已服用'), findsNothing);
      await tester.tap(find.text('重试原纠正'));
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(2));
      expect(server.posts[1], server.posts[0]);
      expect(server.events, hasLength(2));
      expect(find.text('重试原纠正'), findsNothing);
      expect(find.text('纠正为已服用'), findsOneWidget);
      expect(find.textContaining('Original recorder'), findsOneWidget);
      expect(find.textContaining('Correcting member'), findsOneWidget);
    },
  );

  testWidgets(
    'idempotent replay uses latest server status after another member correction',
    (tester) async {
      final server = _HistoryServer()..loseNextAcceptedResponse = true;
      await _mount(tester, server);
      await _openCorrection(tester);
      await _submitDialog(tester);
      await tester.pumpAndSettle();
      server.status = 'taken';
      server.events.add({
        'action': 'taken',
        'actor': 'Another member',
        'at': '2026-10-03 09:13',
      });
      await tester.tap(find.text('重试原纠正'));
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(2));
      expect(server.posts.last, server.posts.first);
      expect(server.events, hasLength(3));
      expect(find.text('纠正为已跳过'), findsOneWidget);
      expect(find.text('纠正为已服用'), findsNothing);
      expect(find.textContaining('Another member'), findsOneWidget);
      expect(find.text('原纠正结果已核对，当前状态以最新历史为准。'), findsOneWidget);
      expect(find.text('纠正已保存'), findsNothing);
      expect(find.text('重试原纠正'), findsNothing);
    },
  );

  testWidgets(
    'unresolved correction survives page remount with original operation key',
    (tester) async {
      final server = _HistoryServer()..loseNextAcceptedResponse = true;
      await _mount(tester, server);
      await _openCorrection(tester);
      await _submitDialog(tester);
      await tester.pumpAndSettle();
      await tester.pumpWidget(const MaterialApp(home: Text('Another page')));
      await _mount(tester, server, key: const ValueKey('returned'));
      expect(find.text('重试原纠正'), findsOneWidget);
      expect(server.posts, hasLength(1));
      await tester.tap(find.text('重试原纠正'));
      await tester.pumpAndSettle();
      expect(server.posts[1], server.posts[0]);
      expect(server.events, hasLength(2));
    },
  );

  testWidgets(
    'leaving during submission causes no stale UI and remount stays locked until settled',
    (tester) async {
      final server = _HistoryServer()..postGate = Completer<void>();
      await _mount(tester, server);
      await _openCorrection(tester);
      await _submitDialog(tester);
      await tester.pump();
      expect(server.posts, hasLength(1));
      await tester.pumpWidget(const MaterialApp(home: Text('Another page')));
      await _mount(tester, server, key: const ValueKey('returned'));
      expect(server.posts, hasLength(1));
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, '纠正为已跳过'),
            )
            .onPressed,
        isNull,
      );
      server.postGate!.complete();
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
      expect(find.text('纠正为已服用'), findsOneWidget);
      expect(find.textContaining('Correcting member'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'old history response cannot win a correction settling during remount load',
    (tester) async {
      final server = _HistoryServer()..postGate = Completer<void>();
      await _mount(tester, server);
      await _openCorrection(tester);
      await _submitDialog(tester);
      await tester.pump();
      await tester.pumpWidget(const MaterialApp(home: Text('Another page')));
      server.historyGate = Completer<void>();
      await tester.pumpWidget(
        MaterialApp(
          home: PlanHistoryPage(repository: server.repository, planId: 'plan'),
        ),
      );
      await tester.pump();
      expect(server.historyReads, 2);
      server.postGate!.complete();
      await tester.pump();
      await tester.pump();
      server.historyGate!.complete();
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
      expect(server.historyReads, 3);
      expect(find.text('纠正为已服用'), findsOneWidget);
      expect(find.textContaining('Correcting member'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('dismissing the dialog by navigation never posts', (
    tester,
  ) async {
    final server = _HistoryServer();
    await _mount(tester, server);
    await _openCorrection(tester);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(server.posts, isEmpty);
    expect(find.text('纠正为已跳过'), findsOneWidget);
  });

  testWidgets(
    'leaving an unconfirmed dialog never posts and identity change invalidates it',
    (tester) async {
      final server = _HistoryServer();
      await _mount(tester, server);
      await _openCorrection(tester);
      server.api.invalidateIdentity();
      await _submitDialog(tester);
      await tester.pumpAndSettle();
      expect(server.posts, isEmpty);
      expect(find.text('纠正为已跳过'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'confirmed POST remains acknowledged when dependent synchronization fails',
    (tester) async {
      final server = _HistoryServer();
      server.repository.onChanged = () async =>
          throw const ApiNetworkException('dependent sync failed');
      await _mount(tester, server);
      await _openCorrection(tester);
      await _submitDialog(tester);
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
      expect(server.events, hasLength(2));
      expect(find.textContaining('纠正已保存'), findsOneWidget);
      expect(find.text('重试原纠正'), findsNothing);
      expect(find.text('纠正为已服用'), findsOneWidget);
      expect(find.textContaining('Correcting member'), findsOneWidget);
      await tester.tap(find.byTooltip('刷新历史'));
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
    },
  );

  testWidgets(
    'accepted write followed by failed history refresh never offers write retry',
    (tester) async {
      final server = _HistoryServer();
      await _mount(tester, server);
      await _openCorrection(tester);
      server.historyFails = true;
      await _submitDialog(tester);
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
      expect(server.events, hasLength(2));
      expect(find.textContaining('纠正已保存'), findsWidgets);
      expect(find.text('重试原纠正'), findsNothing);
      expect(find.text('纠正为已跳过'), findsNothing);
      server.historyFails = false;
      await tester.tap(find.byTooltip('刷新历史'));
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
      expect(find.text('纠正为已服用'), findsOneWidget);
    },
  );
}
