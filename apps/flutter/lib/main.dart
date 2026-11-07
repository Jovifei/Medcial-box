import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app.dart';
import 'core/theme/font_scale.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  LicenseRegistry.addLicense(() async* {
    final license = await rootBundle.loadString(
      'assets/fonts/NotoSansSC-OFL.txt',
    );
    yield LicenseEntryWithLineBreaks(const ['Noto Sans CJK SC'], license);
  });
  final fontScale = await FontScaleController.load();
  runApp(HomeMedicineApp(fontScale: fontScale));
}
