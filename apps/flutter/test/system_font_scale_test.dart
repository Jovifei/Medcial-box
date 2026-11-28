import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/app.dart';
import 'package:home_medicine_flutter/core/theme/font_scale.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _NonlinearSystemScaler extends TextScaler {
  const _NonlinearSystemScaler();

  @override
  double scale(double fontSize) => fontSize * (fontSize <= 16 ? 2 : 1.5);

  @override
  double get textScaleFactor => 2;
}

void main() {
  test('app preference preserves the complete nonlinear platform curve', () {
    final controller = FontScaleController.fallback();
    const system = _NonlinearSystemScaler();
    expect(controller.combineWithSystem(system), same(system));
    controller.setting = FontScaleSetting.large;
    final combined = controller.combineWithSystem(system);
    expect(combined.scale(15), 36);
    expect(combined.scale(30), 54);
    controller.dispose();
  });

  testWidgets(
    'root app respects system 200 percent with standard and large preferences',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      tester.view.physicalSize = const Size(1000, 1800);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final controller = FontScaleController.fallback();
      await tester.pumpWidget(
        HomeMedicineApp(
          apiBaseUrl: '',
          initialLocation: '/demo/welcome',
          secretStore: MemorySecretStore(),
          localStore: MemoryInventoryLocalStore(),
          fontScale: controller,
        ),
      );
      await tester.pumpAndSettle();
      var context = tester.element(find.text('开始体验'));
      expect(MediaQuery.textScalerOf(context).scale(15), 30);
      await controller.set(FontScaleSetting.large);
      await tester.pumpAndSettle();
      context = tester.element(find.text('开始体验'));
      expect(MediaQuery.textScalerOf(context).scale(15), 36);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
    },
  );
}
