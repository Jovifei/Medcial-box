import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
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
