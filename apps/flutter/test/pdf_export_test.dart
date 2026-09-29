import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/features/export/pdf_export.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'builds a shareable PDF with embedded Simplified Chinese glyphs',
    () async {
      final font = await rootBundle.load(
        'assets/fonts/MedBoxSansSC-Regular.ttf',
      );
      final bytes = await buildInventoryPdf(
      '# 家庭药箱库存清单\n## 在用库存\n### 布洛芬缓释胶囊\n- 数量：2 盒；开封期限：2026-10-01\n- 用量资料涉及 α、β、μg。库存存在不代表适合服用。',
        font,
      );

      expect(utf8.decode(bytes.take(4).toList()), '%PDF');
      expect(bytes.length, greaterThan(4 * 1024));
    },
  );
}
