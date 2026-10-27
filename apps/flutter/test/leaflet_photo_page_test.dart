import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';
import 'package:home_medicine_flutter/features/medicine/leaflet_photo_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:image_picker/image_picker.dart';

const _pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLJsgAAAABJRU5ErkJggg==';
final _pngBytes = base64Decode(_pngBase64);

class _FakeLeafletPicker implements LeafletImagePicker {
  final List<ImageSource> sources = [];

  @override
  Future<XFile?> pickImage(ImageSource source) async {
    sources.add(source);
    return XFile.fromData(
      _pngBytes,
      name: 'leaflet.png',
      mimeType: 'image/png',
    );
  }
}

void main() {
  for (final transition in ['family', 'logout']) {
    testWidgets(
      'upload preview hides private pixels immediately on $transition',
      (tester) async {
        final id = SessionIdentityState(
          origin: 'https://synthetic.invalid',
          secrets: MemorySecretStore(),
          persistence: MemoryPrivateAtomicState(),
        );
        await id.initialize();
        await id.acceptToken(id.beginLink(), 'synthetic');
        await id.recordOwner(
          expectedGeneration: id.generation!,
          userId: 'user-a',
          familyId: 'family-a',
          isCurrent: () => true,
        );
        var writes = 0;
        final api = ApiClient(
          baseUrl: id.origin,
          identityState: id,
          tokenProvider: id.readAccessToken,
          client: MockClient((request) async {
            if (request.method == 'POST') writes++;
            return http.Response(
              request.url.path.endsWith('/recognition-evidence')
                  ? '{"evidence":null}'
                  : '{"photos":[]}',
              200,
            );
          }),
        );
        addTearDown(api.close);
        await tester.pumpWidget(
          MaterialApp(
            home: LeafletPhotoPage(
              medicineId: 'medicine',
              repository: ApiWorkflowRepository(api: api),
              imagePicker: _FakeLeafletPicker(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('拍摄或选择说明书照片'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('从相册选择'));
        await tester.pumpAndSettle();
        expect(find.byType(Image), findsOneWidget);
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
        expect(find.text('照片预览已隐藏，请重新打开照片资料。'), findsOneWidget);
        expect(writes, 0);
      },
    );
  }

  testWidgets('late delete response cannot change the replaced identity page', (
    tester,
  ) async {
    final entered = Completer<void>();
    final response = Completer<http.Response>();
    var invalidations = 0;
    final api = ApiClient(
      baseUrl: 'https://synthetic.invalid',
      tokenProvider: () async => 'synthetic',
      client: MockClient((request) async {
        if (request.method == 'DELETE') {
          entered.complete();
          return response.future;
        }
        if (request.url.path.endsWith('/recognition-evidence')) {
          return http.Response('{"evidence":null}', 200);
        }
        return http.Response(
          jsonEncode({
            'photos': [_photoJson],
          }),
          200,
        );
      }),
    );
    addTearDown(api.close);
    await tester.pumpWidget(
      MaterialApp(
        home: LeafletPhotoPage(
          medicineId: 'medicine-1',
          repository: ApiWorkflowRepository(api: api),
          onPhotosChanged: () => invalidations++,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('删除说明书照片'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('删除照片'));
    await tester.pump();
    await entered.future;
    api.invalidateIdentity();
    response.complete(http.Response('', 204));
    await tester.pumpAndSettle();
    expect(invalidations, 0);
    expect(find.text('说明书照片已删除。'), findsNothing);
    expect(find.text('包装说明书'), findsNothing);
    expect(find.text('家庭身份已变化，请重新打开照片资料。'), findsOneWidget);
  });

  testWidgets(
    'shows each saved photo result and a removed original without re-recognition',
    (tester) async {
      final paths = <String>[];
      final client = ApiClient(
        baseUrl: 'https://synthetic.invalid',
        tokenProvider: () async => 'synthetic',
        client: MockClient((request) async {
          paths.add('${request.method} ${request.url.path}');
          if (request.url.path.endsWith('/recognition-evidence')) {
            return http.Response.bytes(
              utf8.encode(
                jsonEncode({
                  'evidence': {
                    'schemaVersion': 1,
                    'revision': 1,
                    'medicineVersion': 1,
                    'currentMedicineVersion': 1,
                    'stale': false,
                    'photos': [
                      {
                        'photoId': 'photo-1',
                        'sequence': 1,
                        'status': 'recognized',
                        'fields': {'name': '合成药一'},
                        'warnings': ['合成识别提醒'],
                        'available': true,
                      },
                      {
                        'photoId': 'removed-photo',
                        'sequence': 3,
                        'status': 'recognized',
                        'fields': {'name': '合成药三'},
                        'available': false,
                      },
                    ],
                    'fieldSources': {
                      'name': {
                        'source': 'recognized',
                        'photoIds': ['photo-1'],
                        'reviewed': true,
                      },
                    },
                  },
                }),
              ),
              200,
            );
          }
          if (request.url.path.endsWith('/leaflet-photos/photo-1')) {
            return http.Response.bytes(
              _pngBytes,
              200,
              headers: {'content-type': 'image/png'},
            );
          }
          return http.Response.bytes(
            utf8.encode(
              jsonEncode({
                'photos': [_photoJson],
              }),
            ),
            200,
          );
        }),
      );
      addTearDown(client.close);
      await tester.pumpWidget(
        MaterialApp(
          home: LeafletPhotoPage(
            medicineId: 'medicine-1',
            repository: ApiWorkflowRepository(api: client),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('图1'), findsWidgets);
      expect(find.textContaining('图3'), findsOneWidget);
      expect(find.textContaining('原图不可查看'), findsWidgets);
      expect(find.textContaining('合成药一'), findsOneWidget);
      expect(find.textContaining('合成药三'), findsOneWidget);
      expect(find.text('识别提醒：合成识别提醒'), findsOneWidget);
      expect(paths.every((path) => path.startsWith('GET ')), isTrue);
      await Scrollable.ensureVisible(
        tester.element(find.text('查看图1原图')),
        alignment: 0.3,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('查看图1原图'));
      await tester.pumpAndSettle();
      expect(
        paths,
        contains('GET /api/v1/medicines/medicine-1/leaflet-photos/photo-1'),
      );
      expect(find.byType(Image), findsOneWidget);
    },
  );

  testWidgets(
    'photo upload waits for explicit consent and supports camera, gallery, view and delete',
    (tester) async {
      final picker = _FakeLeafletPicker();
      var uploads = 0;
      var deletes = 0;
      var photoExists = false;
      final client = ApiClient(
        baseUrl: 'https://medicine.example',
        tokenProvider: () async => 'synthetic-session',
        client: MockClient((request) async {
          expect(request.headers['authorization'], 'Bearer synthetic-session');
          final path = request.url.path;
          if (request.method == 'GET' &&
              path.endsWith('/leaflet-photos/photo-1')) {
            return http.Response.bytes(
              _pngBytes,
              200,
              headers: {'content-type': 'image/png'},
            );
          }
          if (request.method == 'GET' && path.endsWith('/leaflet-photos')) {
            return http.Response.bytes(
              utf8.encode(
                jsonEncode({
                  'photos': photoExists ? [_photoJson] : [],
                }),
              ),
              200,
            );
          }
          if (request.method == 'POST') {
            uploads++;
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            expect(body['mimeType'], 'image/png');
            expect(base64Decode(body['imageBase64'] as String), _pngBytes);
            photoExists = true;
            return http.Response.bytes(
              utf8.encode(jsonEncode({'photo': _photoJson})),
              201,
            );
          }
          expect(request.method, 'DELETE');
          deletes++;
          photoExists = false;
          return http.Response('', 204);
        }),
      );
      final workflow = ApiWorkflowRepository(api: client);

      await tester.pumpWidget(
        MaterialApp(
          home: LeafletPhotoPage(
            medicineId: 'medicine-1',
            repository: workflow,
            imagePicker: picker,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('还没有说明书照片'), findsOneWidget);
      expect(uploads, 0);

      await tester.tap(find.text('拍摄或选择说明书照片'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('拍摄说明书照片'));
      await tester.pumpAndSettle();
      expect(find.text('确认上传说明书照片'), findsOneWidget);
      expect(find.textContaining('已加入该家庭的成员都可以查看'), findsOneWidget);
      expect(uploads, 0);
      await tester.tap(find.text('暂不上传'));
      await tester.pumpAndSettle();
      expect(uploads, 0);

      await tester.tap(find.text('拍摄或选择说明书照片'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('从相册选择'));
      await tester.pumpAndSettle();
      expect(find.text('确认上传说明书照片'), findsOneWidget);
      expect(uploads, 0);
      await tester.tap(find.text('上传到家庭药箱'));
      await tester.pumpAndSettle();
      expect(uploads, 1);
      expect(picker.sources, [ImageSource.camera, ImageSource.gallery]);
      expect(find.text('说明书照片'), findsWidgets);
      expect(find.text('包装说明书'), findsOneWidget);

      await tester.tap(find.byTooltip('查看说明书照片'));
      await tester.pumpAndSettle();
      expect(find.text('说明书图片'), findsOneWidget);
      expect(find.byType(Image), findsOneWidget);
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('删除说明书照片'));
      await tester.pumpAndSettle();
      expect(find.text('删除这张说明书照片？'), findsOneWidget);
      await tester.tap(find.text('删除照片'));
      await tester.pumpAndSettle();
      expect(deletes, 1);
      expect(find.text('还没有说明书照片'), findsOneWidget);
    },
  );
}

Map<String, dynamic> get _photoJson => {
  'id': 'photo-1',
  'medicineId': 'medicine-1',
  'contentType': 'image/png',
  'sizeBytes': _pngBytes.length,
  'source': 'package_leaflet',
  'createdAt': '2026-09-29T02:00:00.000Z',
  'url': '/api/v1/medicines/medicine-1/leaflet-photos/photo-1',
};
