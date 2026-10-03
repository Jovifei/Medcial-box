import 'dart:convert';

import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';
import 'package:image_picker/image_picker.dart';

import 'api_client.dart';

class MedicineRecognitionDraft {
  const MedicineRecognitionDraft({
    required this.name,
    required this.specification,
    required this.expiry,
    required this.rawText,
    required this.warnings,
    this.purposeCategory,
    this.purposeTags = const [],
  });
  final String name;
  final String specification;
  final String expiry;
  final String rawText;
  final List<String> warnings;
  final String? purposeCategory;
  final List<String> purposeTags;
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

class ApiMedicineRecognitionRepository
    implements MedicineRecognitionRepository {
  ApiMedicineRecognitionRepository(this.api);

  final ApiClient api;

  @override
  Future<MedicineRecognitionDraft> recognize(XFile image) async {
    if (await image.length() > 4 * 1024 * 1024) {
      throw const FormatException('请选择不超过 4 MB 的药盒照片。');
    }
    final bytes = await image.readAsBytes();
    if (bytes.length < 128 || bytes.length > 4 * 1024 * 1024) {
      throw const FormatException('照片格式或大小不正确。');
    }
    final String mimeType;
    if (bytes[0] == 0xff &&
        bytes[1] == 0xd8 &&
        bytes[2] == 0xff &&
        bytes[bytes.length - 2] == 0xff &&
        bytes.last == 0xd9) {
      mimeType = 'image/jpeg';
    } else if (bytes.take(8).join(',') == '137,80,78,71,13,10,26,10' &&
        bytes.skip(bytes.length - 8).join(',') == '73,69,78,68,174,66,96,130') {
      mimeType = 'image/png';
    } else {
      throw const FormatException('仅支持 JPEG 或 PNG 药盒照片。');
    }
    final result = await api.post(
      '/api/v1/recognitions/medicine',
      body: {'imageBase64': base64Encode(bytes), 'mimeType': mimeType},
    );
    if (result is! Map<String, dynamic> ||
        result['draft'] is! Map<String, dynamic>) {
      throw const FormatException('识别结果格式异常，请重试。');
    }
    final draft = result['draft'] as Map<String, dynamic>;
    String? field(String key) {
      final value = draft[key];
      return value is String && value.trim().isNotEmpty ? value.trim() : null;
    }

    return MedicineRecognitionDraft(
      name: field('name') ?? '',
      specification: field('specification') ?? '',
      expiry: field('expiryValue') ?? '待补充',
      rawText: '',
      warnings: result['warnings'] is List
          ? (result['warnings'] as List).whereType<String>().toList()
          : const [],
      purposeCategory: field('purposeCategory'),
      purposeTags: (draft['purposeTags'] as List? ?? []).whereType<String>().toList(),
    );
  }
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
