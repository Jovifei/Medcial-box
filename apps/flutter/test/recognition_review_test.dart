import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/domain/recognition_review.dart';

Map<String, dynamic> photo(
  String id,
  int sequence,
  Map<String, dynamic> fields,
) => {'clientPhotoId': id, 'sequence': sequence, 'recognitionFields': fields};

void main() {
  test(
    'same values merge their photo sources and conflicts require a choice',
    () {
      final review = RecognitionReview();
      final photos = [
        photo('a', 1, {'name': '  合成药  ', 'specification': '10mg'}),
        photo('b', 2, {'name': '合成药', 'specification': '20mg'}),
        photo('c', 3, {'name': '合成药', 'specification': '10mg'}),
      ];
      final names = review.candidates('name', photos);
      expect(names, hasLength(1));
      expect(names.single.value, '合成药');
      expect(names.single.photoIds, ['a', 'b', 'c']);
      final specs = review.candidates('specification', photos);
      expect(specs, hasLength(2));
      expect(specs.first.photoIds, ['a', 'c']);
      expect(review.requiresChoice('specification', photos), isTrue);
      review.accept('specification', specs.first, photos, reviewed: true);
      expect(review.requiresChoice('specification', photos), isFalse);
      photos.add(photo('d', 4, {'specification': '30mg'}));
      expect(review.requiresChoice('specification', photos), isTrue);
    },
  );

  test('manual edits and explicit empty values survive restoration and new suggestions', () {
    final review = RecognitionReview();
    review.markManual('name');
    review.markManual('populationTags');
    final restored = RecognitionReview.fromJson(review.toJson());
    expect(restored.canAutoApply('name'), isFalse);
    expect(restored.canAutoApply('populationTags'), isFalse);
    expect(restored.canAutoApply('manufacturer'), isTrue);
    expect(restored.source('name')?.source, 'manual');
  });

  test(
    'removing a selected photo preserves the accepted value source as removed',
    () {
      final review = RecognitionReview();
      final photos = [
        photo('a', 1, {'name': '合成药'}),
        photo('b', 2, {'name': '其他'}),
      ];
      review.accept(
        'name',
        review.candidates('name', photos).first,
        photos,
        reviewed: true,
      );
      review.removePhoto('a');
      expect(review.source('name')?.source, 'removed');
      expect(review.source('name')?.photoIds, isEmpty);
      expect(review.canAutoApply('name'), isFalse);
    },
  );
}
