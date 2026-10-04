import 'dart:io';
import 'dart:typed_data';

/// Host-only fixture for deterministic layout and PDF glyph regression tests.
/// The production APK intentionally does not bundle this 10 MB font.
Future<ByteData> loadChineseFontFixture() async {
  final bytes = await File('assets/fonts/MedBoxSansSC-Regular.ttf').readAsBytes();
  return ByteData.sublistView(bytes);
}
