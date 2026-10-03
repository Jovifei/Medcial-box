import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/medicine_recognition.dart';
import 'package:image_picker/image_picker.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('medicine OCR requests the bundled Chinese model and closes it', () async {
    const channel = MethodChannel('google_mlkit_text_recognizer');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final calls = <MethodCall>[];
    const rawText = '复方对乙酰氨基酚片\n0.5g × 12片\n有效期至：2027年12月31日';

    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (call.method == 'vision#startTextRecognizer') {
        return <String, Object>{'text': rawText, 'blocks': <Object>[]};
      }
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    final image = XFile('/synthetic/medicine-box.png');
    final draft = await MlKitMedicineRecognitionRepository().recognize(image);

    expect(calls.map((call) => call.method), <String>[
      'vision#startTextRecognizer',
      'vision#closeTextRecognizer',
    ]);
    final start = calls.first.arguments as Map;
    // Native script 1 is Chinese in the locked plugin. Release rules omit only
    // the unselected Devanagari/Japanese/Korean models; update dependencies and
    // those rules before changing the production recognition script.
    expect(start['script'], 1);
    expect((start['imageData'] as Map)['path'], image.path);
    expect(start['id'], isNotEmpty);
    expect((calls.last.arguments as Map)['id'], start['id']);
    expect(draft.rawText, rawText);
    expect(draft.name, '复方对乙酰氨基酚片');
    expect(draft.expiry, '2027-12-31');
    expect(draft.warnings, isEmpty);
  });
}
