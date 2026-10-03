import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:home_medicine_flutter/models/plan_models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

ApiPlanRepository repository(
  Future<http.Response> Function(http.Request) send,
) => ApiPlanRepository(
  api: ApiClient(
    baseUrl: 'https://medicine.example',
    tokenProvider: () async => 'test-token',
    client: MockClient(send),
  ),
);

void main() {
  test('family cache retains account identity separately from membership', () {
    final family = FamilyRecord.fromJson({
      'id': 'family',
      'members': [
        {'id': 'membership-7', 'userId': 'account-9', 'displayName': 'Member'},
      ],
    });
    final cached = FamilyRecord.fromJson(
      jsonDecode(jsonEncode(family.toCacheJson())) as Map<String, dynamic>,
    );
    expect(cached.members.single.id, 'membership-7');
    expect(cached.members.single.toCacheJson()['userId'], 'account-9');
  });

  test('legacy and malformed member identities are never guessed from id', () {
    for (final value in [null, '', '   ', 7]) {
      final member = FamilyMemberRecord.fromJson({
        'id': 'membership-only',
        'userId': ?value,
      });
      expect(member.id, 'membership-only');
      expect(member.toCacheJson()['userId'], isNull);
    }
  });

  for (final canManage in [false, true]) {
    for (final receive in [false, true]) {
      test('grant payload: manage=$canManage, reminders=$receive', () async {
        final repo = repository((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, '/api/v1/care-profiles/profile/grants');
          expect(jsonDecode(request.body), {
            'memberUserId': 'account-9',
            'canView': true,
            'canManage': canManage,
            'receiveDoseReminders': receive,
          });
          return http.Response('{}', 200);
        });
        addTearDown(repo.dispose);
        await repo.createCareGrant(
          'profile',
          memberUserId: 'account-9',
          canManage: canManage,
          receiveDoseReminders: receive,
        );
      });
    }
  }

  test(
    'new grant defaults reminders off even when management is enabled',
    () async {
      final repo = repository((request) async {
        expect(jsonDecode(request.body), {
          'memberUserId': 'account-9',
          'canView': true,
          'canManage': true,
          'receiveDoseReminders': false,
        });
        return http.Response('{}', 200);
      });
      addTearDown(repo.dispose);
      await repo.createCareGrant(
        'profile',
        memberUserId: 'account-9',
        canManage: true,
      );
    },
  );

  test(
    'successful grant change notifies once and awaits reminder refresh',
    () async {
      final response = Completer<http.Response>();
      final refresh = Completer<void>();
      var listeners = 0;
      var refreshes = 0;
      var completed = false;
      final repo = repository((_) => response.future)
        ..onChanged = () {
          refreshes++;
          return refresh.future;
        };
      repo.addListener(() => listeners++);
      addTearDown(repo.dispose);
      final mutation = repo
          .createCareGrant(
            'profile',
            memberUserId: 'account-9',
            canManage: false,
          )
          .then((_) => completed = true);
      await Future<void>.delayed(Duration.zero);
      expect(listeners, 0);
      expect(refreshes, 0);
      response.complete(http.Response('{}', 200));
      await Future<void>.delayed(Duration.zero);
      expect(listeners, 1);
      expect(refreshes, 1);
      expect(completed, false);
      refresh.complete();
      await mutation;
      expect(completed, true);
      expect(listeners, 1);
      expect(refreshes, 1);
    },
  );

  test(
    'rejected grant does not announce or refresh a saved mutation',
    () async {
      var listeners = 0;
      var refreshes = 0;
      final repo =
          repository(
              (_) async => http.Response(
                '{"error":{"code":"FORBIDDEN","message":"Denied"}}',
                403,
              ),
            )
            ..onChanged = () async {
              refreshes++;
            };
      repo.addListener(() => listeners++);
      addTearDown(repo.dispose);
      await expectLater(
        repo.createCareGrant(
          'profile',
          memberUserId: 'account-9',
          canManage: false,
        ),
        throwsA(isA<ApiException>()),
      );
      expect(listeners, 0);
      expect(refreshes, 0);
    },
  );

  test(
    'grant and schedule models never infer reminder consent from access',
    () {
      for (final value in [null, false, 'true', 1, true]) {
        final grant = CareGrant.fromJson({
          'canView': true,
          'canManage': true,
          'receiveDoseReminders': ?value,
        });
        final entry = ScheduleEntry.fromJson({'receiveDoseReminders': ?value});
        expect(grant.receiveDoseReminders, value == true);
        expect(entry.receiveDoseReminders, value == true);
      }
    },
  );
}
