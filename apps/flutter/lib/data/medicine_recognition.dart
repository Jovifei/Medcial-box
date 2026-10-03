import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';
import 'package:image_picker/image_picker.dart';

class MedicineRecognitionDraft {
  const MedicineRecognitionDraft({
    required this.name,
    required this.specification,
    required this.expiry,
    required this.rawText,
    required this.warnings,
  });
  final String name;
  final String specification;
  final String expiry;
  final String rawText;
  final List<String> warnings;
}

class MedicineTextParser {
  MedicineRecognitionDraft parse(String rawText) {
    final text = rawText.trim();
    final lines = text
        .split(RegExp(r'[\r\n]+'))
        .map((line) => line.trim())
        .where((line) => line.isNotEmpty)
        .toList();
    final name = _findName(lines);
    final specification = _findSpecification(lines);
    final expiry = _findExpiry(text);
    final warnings = <String>[];
    if (name.isEmpty) warnings.add('没有可靠识别出药品名称，请人工填写。');
    if (expiry == '待补充') warnings.add('没有识别出有效期，请对照药盒手动补充。');
    if (text.isEmpty) warnings.add('图片中没有识别到文字，请换一张清晰照片。');
    return MedicineRecognitionDraft(
      name: name,
      specification: specification,
      expiry: expiry,
      rawText: text,
      warnings: warnings,
    );
  }

  String _findName(List<String> lines) {
    final medicineWords = RegExp(r'(片|胶囊|颗粒|口服液|喷雾|滴眼液|软膏|凝胶|贴膏|丸|散|糖浆)');
    for (final line in lines) {
      final match = medicineWords.firstMatch(line);
      if (match == null) continue;
      var candidate = line.substring(0, match.end).trim();
      candidate = candidate
          .replaceFirst(
            RegExp(r'^(?:药品名称(?:（必填）)?|通用名称|通用名|产品名称|商品名|名称)[:：\s]*'),
            '',
          )
          .trim();
      final separator = candidate.lastIndexOf(RegExp(r'[\s:：|·]'));
      if (separator >= 0) candidate = candidate.substring(separator + 1).trim();
      if (candidate.length >= 2 && candidate.length <= 32) return candidate;
    }
    return '';
  }

  String _findSpecification(List<String> lines) {
    final pattern = RegExp(
      r'\d+(?:\.\d+)?\s*(?:mg|μg|ug|g|kg|ml|mL|L|片|粒|袋|瓶|支)',
      caseSensitive: false,
    );
    for (final line in lines) {
      if (pattern.hasMatch(line)) return line;
    }
    return '';
  }

  String _findExpiry(String text) {
    // A bare date could be a manufacture date, batch code, or another number
    // on the box. Only accept dates that OCR ties to an expiry label.
    final match = RegExp(
      r'(?:有效期至|有效期|失效日期|失效期至|失效期)\s*[:：]?\s*(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})(?:\s*(?:月|[-/.])\s*(\d{1,2})\s*日?)?',
    ).firstMatch(text);
    if (match == null) return '待补充';
    final year = match.group(1)!;
    final month = match.group(2)!.padLeft(2, '0');
    final day = match.group(3);
    return day == null ? '$year-$month' : '$year-$month-${day.padLeft(2, '0')}';
  }
}

abstract class MedicineRecognitionRepository {
  Future<MedicineRecognitionDraft> recognize(XFile image);
}

class MlKitMedicineRecognitionRepository
    implements MedicineRecognitionRepository {
  final MedicineTextParser parser = MedicineTextParser();

  @override
  Future<MedicineRecognitionDraft> recognize(XFile image) async {
    final recognizer = TextRecognizer(script: TextRecognitionScript.chinese);
    try {
      final result = await recognizer.processImage(
        InputImage.fromFilePath(image.path),
      );
      return parser.parse(result.text);
    } finally {
      await recognizer.close();
    }
  }
}
