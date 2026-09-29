import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app.dart';

void main() {
  LicenseRegistry.addLicense(() async* {
    final license = await rootBundle.loadString(
      'assets/fonts/NotoSansSC-OFL.txt',
    );
    yield LicenseEntryWithLineBreaks(const ['Noto Sans CJK SC'], license);
  });
  runApp(const HomeMedicineApp());
}
