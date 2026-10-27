import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/core/widgets/private_medicine_image.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_detail_api_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final _image = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
);

Future<SessionIdentityState> _identity() async {
  final identity = SessionIdentityState(
    origin: 'https://synthetic.invalid',
    secrets: MemorySecretStore(),
    persistence: MemoryPrivateAtomicState(),
  );
  await identity.initialize();
  await identity.acceptToken(identity.beginLink(), 'synthetic-token');
  await _setFamily(identity, 'family-a');
  return identity;
}

Future<void> _setFamily(SessionIdentityState identity, String family) =>
    identity.recordOwner(
      expectedGeneration: identity.generation!,
      userId: 'user',
      familyId: family,
      isCurrent: () => true,
    );

Widget _imagePage(
  PrivateMedicineImageLoader loader, {
  String? photoId = 'photo',
}) => MaterialApp(
  home: Scaffold(
    body: Center(
      child: PrivateMedicineImage(
        loader: loader,
        medicineId: 'medicine',
        photoId: photoId,
        width: 80,
        height: 80,
      ),
    ),
  ),
);

Uint8List _displayedBytes(WidgetTester tester) {
  final provider =
      tester.widget<Image>(find.byType(Image)).image as ResizeImage;
  return (provider.imageProvider as MemoryImage).bytes;
}

class _Fixture {
  _Fixture(this.api, this.identity, this.photoRequests);
  final ApiClient api;
  final SessionIdentityState identity;
  final List<String> photoRequests;

  static Future<_Fixture> create(String user) async {
    final identity = SessionIdentityState(
      origin: 'https://synthetic.invalid',
      secrets: MemorySecretStore(),
      persistence: MemoryPrivateAtomicState(),
    );
    await identity.initialize();
    await identity.acceptToken(identity.beginLink(), 'synthetic-token');
    await identity.recordOwner(
      expectedGeneration: identity.generation!,
      userId: user,
      familyId: 'family',
      isCurrent: () => true,
    );
    final requests = <String>[];
    final api = ApiClient(
      baseUrl: identity.origin,
      tokenProvider: identity.readAccessToken,
      identityState: identity,
      client: MockClient((request) async {
        if (request.url.path.endsWith('/leaflet-photos/photo')) {
          requests.add(user);
          return http.Response.bytes(
            _image,
            200,
            headers: {'content-type': 'image/png'},
          );
        }
        final data = request.url.path.endsWith('/dosage-notes')
            ? {'notes': []}
            : {
                'id': 'medicine',
                'name': '合成药品',
                'coverPhotoId': 'photo',
                'batches': [],
                'leaflet': {'reviewStatus': 'unverified'},
              };
        return http.Response(
          jsonEncode(data),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    return _Fixture(api, identity, requests);
  }

  Widget page(Key key) => MaterialApp(
    home: MedicineDetailApiPage(
      key: key,
      repository: ApiMedicineRepository(
        api: api,
        localStore: MemoryInventoryLocalStore(),
      ),
      workflow: ApiWorkflowRepository(api: api),
      medicineId: 'medicine',
    ),
  );
}

void main() {
  testWidgets(
    'different clients with matching photo IDs fetch under their own identity',
    (tester) async {
      final first = await _Fixture.create('user-a');
      final second = await _Fixture.create('user-b');
      addTearDown(first.api.close);
      addTearDown(second.api.close);
      await tester.pumpWidget(first.page(const ValueKey('a')));
      await tester.pumpAndSettle();
      expect(first.photoRequests, ['user-a']);
      expect(find.byType(Image), findsOneWidget);

      await tester.pumpWidget(second.page(const ValueKey('b')));
      await tester.pumpAndSettle();
      expect(second.photoRequests, ['user-b']);
    },
  );

  testWidgets('replacing a mounted detail client cannot retain its old image', (
    tester,
  ) async {
    final first = await _Fixture.create('user-a');
    final second = await _Fixture.create('user-b');
    addTearDown(first.api.close);
    addTearDown(second.api.close);
    const key = ValueKey('same-detail');
    await tester.pumpWidget(first.page(key));
    await tester.pumpAndSettle();
    await tester.pumpWidget(second.page(key));
    await tester.pumpAndSettle();
    expect(second.photoRequests, ['user-b']);
  });

  testWidgets('same scope reuses the future across rebuilds and remounts', (
    tester,
  ) async {
    final identity = await _identity();
    var requests = 0;
    final api = ApiClient(
      baseUrl: identity.origin,
      identityState: identity,
      tokenProvider: identity.readAccessToken,
      client: MockClient((request) async {
        requests++;
        return http.Response.bytes(_image, 200);
      }),
    );
    final loader = PrivateMedicineImageLoader(api);
    addTearDown(loader.dispose);
    addTearDown(api.close);
    await tester.pumpWidget(_imagePage(loader));
    await tester.pumpAndSettle();
    await tester.pumpWidget(_imagePage(loader));
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(_imagePage(loader));
    await tester.pumpAndSettle();
    expect(requests, 1);
    expect(_displayedBytes(tester), orderedEquals(_image));
  });

  testWidgets(
    'family change clears the old image and rejects a late response',
    (tester) async {
      final identity = await _identity();
      final oldResponse = Completer<http.Response>();
      final requests = <String?>[];
      final newer = Uint8List.fromList([..._image, 2]);
      final api = ApiClient(
        baseUrl: identity.origin,
        identityState: identity,
        tokenProvider: identity.readAccessToken,
        client: MockClient((request) async {
          requests.add(request.headers['x-family-id']);
          if (request.headers['x-family-id'] == 'family-a') {
            return oldResponse.future;
          }
          return http.Response.bytes(newer, 200);
        }),
      );
      final loader = PrivateMedicineImageLoader(api);
      addTearDown(loader.dispose);
      addTearDown(api.close);
      await tester.pumpWidget(_imagePage(loader));
      await tester.pump();
      expect(requests, ['family-a']);
      await _setFamily(identity, 'family-b');
      await tester.pumpAndSettle();
      expect(requests, ['family-a', 'family-b']);
      expect(_displayedBytes(tester), orderedEquals(newer));
      oldResponse.complete(http.Response.bytes(_image, 200));
      await tester.pumpAndSettle();
      expect(_displayedBytes(tester), orderedEquals(newer));
    },
  );

  testWidgets('logout immediately removes an already displayed private image', (
    tester,
  ) async {
    final identity = await _identity();
    var requests = 0;
    final api = ApiClient(
      baseUrl: identity.origin,
      identityState: identity,
      tokenProvider: identity.readAccessToken,
      client: MockClient((request) async {
        requests++;
        return http.Response.bytes(_image, 200);
      }),
    );
    final loader = PrivateMedicineImageLoader(api);
    addTearDown(loader.dispose);
    addTearDown(api.close);
    await tester.pumpWidget(_imagePage(loader));
    await tester.pumpAndSettle();
    expect(find.byType(Image), findsOneWidget);
    identity.beginSignOut();
    await tester.pump();
    expect(find.byType(Image), findsNothing);
    expect(requests, 1);
  });

  testWidgets('no verified family means no photo request is sent', (
    tester,
  ) async {
    final identity = await _identity();
    await identity.clearFamily();
    var requests = 0;
    final api = ApiClient(
      baseUrl: identity.origin,
      identityState: identity,
      tokenProvider: identity.readAccessToken,
      client: MockClient((request) async {
        requests++;
        return http.Response.bytes(_image, 200);
      }),
    );
    final loader = PrivateMedicineImageLoader(api);
    addTearDown(loader.dispose);
    addTearDown(api.close);
    await tester.pumpWidget(_imagePage(loader));
    await tester.pumpAndSettle();
    expect(requests, 0);
    expect(find.byType(Image), findsNothing);
  });

  testWidgets(
    'a denied photo is never displayed or treated as cached success',
    (tester) async {
      final identity = await _identity();
      var requests = 0;
      final api = ApiClient(
        baseUrl: identity.origin,
        identityState: identity,
        tokenProvider: identity.readAccessToken,
        client: MockClient((request) async {
          requests++;
          expect(request.headers['x-family-id'], 'family-a');
          return http.Response(
            jsonEncode({
              'error': {'code': 'FORBIDDEN', 'message': 'denied'},
            }),
            403,
          );
        }),
      );
      final loader = PrivateMedicineImageLoader(api);
      addTearDown(loader.dispose);
      addTearDown(api.close);
      await tester.pumpWidget(_imagePage(loader));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsNothing);
      await tester.tap(find.byIcon(Icons.broken_image_outlined));
      await tester.pumpAndSettle();
      expect(requests, 2);
      expect(find.byType(Image), findsNothing);
    },
  );

  testWidgets('identity epoch and photo mutations invalidate cached images', (
    tester,
  ) async {
    final identity = await _identity();
    var requests = 0;
    final api = ApiClient(
      baseUrl: identity.origin,
      identityState: identity,
      tokenProvider: identity.readAccessToken,
      client: MockClient((request) async {
        requests++;
        return http.Response.bytes(_image, 200);
      }),
    );
    final loader = PrivateMedicineImageLoader(api);
    addTearDown(loader.dispose);
    addTearDown(api.close);
    await tester.pumpWidget(_imagePage(loader));
    await tester.pumpAndSettle();
    api.invalidateIdentity();
    await tester.pumpAndSettle();
    expect(requests, 2);
    loader.invalidatePhotos();
    await tester.pumpAndSettle();
    expect(requests, 3);
    await tester.pumpWidget(_imagePage(loader, photoId: null));
    await tester.pumpAndSettle();
    expect(find.byType(Image), findsNothing);
    expect(requests, 3);
  });

  testWidgets('failed image load keeps its size and retries on tap', (
    tester,
  ) async {
    final identity = await _identity();
    var requests = 0;
    final api = ApiClient(
      baseUrl: identity.origin,
      identityState: identity,
      tokenProvider: identity.readAccessToken,
      client: MockClient((request) async {
        requests++;
        return requests == 1
            ? http.Response('unavailable', 503)
            : http.Response.bytes(_image, 200);
      }),
    );
    final loader = PrivateMedicineImageLoader(api);
    addTearDown(loader.dispose);
    addTearDown(api.close);
    await tester.pumpWidget(_imagePage(loader));
    await tester.pumpAndSettle();
    final frame = find.byType(PrivateMedicineImage);
    expect(tester.getSize(frame), const Size(80, 80));
    expect(find.byIcon(Icons.broken_image_outlined), findsOneWidget);
    await tester.tap(find.byIcon(Icons.broken_image_outlined));
    await tester.pumpAndSettle();
    expect(requests, 2);
    expect(tester.getSize(frame), const Size(80, 80));
    expect(find.byType(Image), findsOneWidget);
  });
}
