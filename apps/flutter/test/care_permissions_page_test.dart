import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_auth_repository.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/plan/care_permissions_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class CareFixture {
  CareFixture({List<Map<String, dynamic>> initialGrants = const []}) {
    grants.addAll(initialGrants);
    api = ApiClient(
      baseUrl: 'https://medicine.example',
      tokenProvider: () async => 'test-token',
      client: MockClient((request) async {
        if (request.method == 'GET' && request.url.path.endsWith('/grants')) {
          return response({
            'careProfileId': 'profile',
            'displayName': 'Child',
            'grants': grants,
          });
        }
        if (request.method == 'GET' &&
            request.url.path == '/api/v1/families/current') {
          return response({
            'family': {
              'id': 'family',
              'name': 'Synthetic family',
              'role': 'member',
              'members': members,
            },
          });
        }
        if (request.method == 'POST' && request.url.path.endsWith('/grants')) {
          expect(request.url.path, '/api/v1/care-profiles/profile/grants');
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          writes.add(body);
          if (pending != null) await pending!.future;
          if (rejectWrites) {
            return response({
              'error': {'code': 'FORBIDDEN', 'message': 'Denied'},
            }, 403);
          }
          grants.removeWhere(
            (grant) => grant['memberUserId'] == body['memberUserId'],
          );
          grants.add({
            'displayName': body['memberUserId'] == 'account-new'
                ? 'Eligible'
                : 'Existing',
            ...body,
            'canView': body['canManage'] == true || body['canView'] != false,
            'receiveDoseReminders': body['receiveDoseReminders'] == true,
          });
          return response({});
        }
        throw StateError(
          'Unexpected request: ${request.method} ${request.url}',
        );
      }),
    );
    plans = ApiPlanRepository(api: api)
      ..onChanged = () async {
        changed++;
      };
    families = ApiFamilyRepository(
      api: api,
      localStore: MemoryInventoryLocalStore(),
    );
  }

  final grants = <Map<String, dynamic>>[];
  final writes = <Map<String, dynamic>>[];
  final members = <Map<String, dynamic>>[
    {
      'id': 'membership-self',
      'userId': 'account-self',
      'displayName': 'Self',
      'isSelf': true,
    },
    {
      'id': 'membership-existing',
      'userId': 'account-existing',
      'displayName': 'Existing',
    },
    {'id': 'membership-legacy', 'displayName': 'Legacy'},
    {'id': 'membership-empty', 'userId': '', 'displayName': 'Empty'},
    {'id': 'membership-blank', 'userId': '   ', 'displayName': 'Blank'},
    {'id': 'membership-number', 'userId': 9, 'displayName': 'Numeric'},
    {
      'id': 'membership-new',
      'userId': 'account-new',
      'displayName': 'Eligible',
    },
  ];
  late final ApiClient api;
  late final ApiPlanRepository plans;
  late final ApiFamilyRepository families;
  int changed = 0;
  bool rejectWrites = false;
  Completer<void>? pending;

  http.Response response(Object body, [int status = 200]) =>
      http.Response.bytes(utf8.encode(jsonEncode(body)), status);

  Future<void> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(plans.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: CarePermissionsPage(
          repository: plans,
          families: families,
          careProfileId: 'profile',
        ),
      ),
    );
    await tester.pumpAndSettle();
  }
}

Map<String, dynamic> existingGrant({
  bool view = false,
  bool manage = false,
  bool receive = false,
}) => {
  'memberUserId': 'account-existing',
  'displayName': 'Existing',
  'canView': view,
  'canManage': manage,
  'receiveDoseReminders': receive,
};

Finder get manageSwitch => find.widgetWithText(SwitchListTile, 'Existing');
Finder get reminderSwitch => find.widgetWithText(SwitchListTile, '接收此人的服药提醒');

void main() {
  testWidgets(
    'picker uses user IDs, hides self, existing grants and unresolved identities',
    (tester) async {
      final fixture = CareFixture(initialGrants: [existingGrant(view: true)]);
      await fixture.open(tester);
      await tester.tap(find.text('添加成员权限'));
      await tester.pumpAndSettle();
      final sheet = find.byType(BottomSheet);
      for (final name in [
        'Self',
        'Existing',
        'Legacy',
        'Empty',
        'Blank',
        'Numeric',
      ]) {
        expect(
          find.descendant(of: sheet, matching: find.text(name)),
          findsNothing,
        );
      }
      await tester.tap(
        find.descendant(of: sheet, matching: find.text('Eligible')),
      );
      await tester.pumpAndSettle();
      expect(fixture.writes, [
        {
          'memberUserId': 'account-new',
          'canView': true,
          'canManage': false,
          'receiveDoseReminders': false,
        },
      ]);
      expect(fixture.changed, 1);
      await tester.ensureVisible(find.text('添加成员权限'));
      await tester.tap(find.text('添加成员权限'));
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.text('没有可添加的家庭成员。'), findsOneWidget);
      expect(fixture.writes.length, 1);
    },
  );

  testWidgets(
    'dismissing member picker does not grant access or opt into reminders',
    (tester) async {
      final fixture = CareFixture(initialGrants: [existingGrant(view: true)]);
      await fixture.open(tester);
      await tester.tap(find.text('添加成员权限'));
      await tester.pumpAndSettle();
      Navigator.of(tester.element(find.text('选择家庭成员'))).pop();
      await tester.pumpAndSettle();
      expect(fixture.writes, isEmpty);
      expect(fixture.changed, 0);
    },
  );

  testWidgets(
    'reminder and management changes preserve independent consent and access',
    (tester) async {
      final fixture = CareFixture(initialGrants: [existingGrant()]);
      await fixture.open(tester);
      for (final value in [true, false]) {
        await tester.tap(reminderSwitch);
        await tester.pumpAndSettle();
        expect(fixture.writes.last, {
          'memberUserId': 'account-existing',
          'canView': false,
          'canManage': false,
          'receiveDoseReminders': value,
        });
        expect(tester.widget<SwitchListTile>(manageSwitch).value, false);
        expect(tester.widget<SwitchListTile>(reminderSwitch).value, value);
      }
      await tester.tap(manageSwitch);
      await tester.pumpAndSettle();
      expect(fixture.writes.last, {
        'memberUserId': 'account-existing',
        'canView': true,
        'canManage': true,
        'receiveDoseReminders': false,
      });
      await tester.tap(reminderSwitch);
      await tester.pumpAndSettle();
      expect(fixture.writes.last, {
        'memberUserId': 'account-existing',
        'canView': true,
        'canManage': true,
        'receiveDoseReminders': true,
      });
      await tester.tap(manageSwitch);
      await tester.pumpAndSettle();
      expect(fixture.writes.last, {
        'memberUserId': 'account-existing',
        'canView': true,
        'canManage': false,
        'receiveDoseReminders': true,
      });
      expect(fixture.changed, 5);
    },
  );

  testWidgets(
    'rejection preserves saved switches and an explicit retry can succeed',
    (tester) async {
      final fixture = CareFixture(initialGrants: [existingGrant()])
        ..rejectWrites = true;
      await fixture.open(tester);
      await tester.tap(reminderSwitch);
      await tester.pumpAndSettle();
      expect(tester.widget<SwitchListTile>(reminderSwitch).value, false);
      expect(tester.widget<SwitchListTile>(manageSwitch).value, false);
      expect(fixture.changed, 0);
      fixture.rejectWrites = false;
      await tester.tap(reminderSwitch);
      await tester.pumpAndSettle();
      expect(fixture.writes.length, 2);
      expect(fixture.writes[1], fixture.writes[0]);
      expect(tester.widget<SwitchListTile>(reminderSwitch).value, true);
      expect(fixture.changed, 1);
    },
  );

  testWidgets(
    'pending mutation disables both switches and tolerates leaving the page',
    (tester) async {
      final fixture = CareFixture(initialGrants: [existingGrant()])
        ..pending = Completer<void>();
      await fixture.open(tester);
      await tester.tap(reminderSwitch);
      await tester.pump();
      expect(tester.widget<SwitchListTile>(reminderSwitch).onChanged, isNull);
      expect(tester.widget<SwitchListTile>(manageSwitch).onChanged, isNull);
      await tester.tap(reminderSwitch);
      await tester.pump();
      expect(fixture.writes.length, 1);
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      fixture.pending!.complete();
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(fixture.writes.length, 1);
    },
  );
}
