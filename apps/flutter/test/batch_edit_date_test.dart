import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_medicine_repository.dart';
import 'package:home_medicine_flutter/data/api_workflow_repository.dart';
import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/features/medicine/medicine_detail_api_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Future<List<http.Request>> open(WidgetTester tester) async {
  final requests = <http.Request>[];
  final medicine = {'id':'medicine','name':'合成测试药品','version':3,
    'batches':[{'id':'batch','quantity':2,'unit':'tube','lotNumber':'OLD',
      'expiry':{'value':'2027-12-31','precision':'day'},'openedState':'unknown','version':2}],
    'leaflet':{'reviewStatus':'unverified'}};
  final api = ApiClient(baseUrl:'https://synthetic.invalid',tokenProvider:() async => null,
    client:MockClient((request) async {
      requests.add(request);
      Object data = medicine;
      if (request.url.path.endsWith('dosage-notes')) { data = {'notes':[]}; }
      else if (request.method == 'PUT' && request.url.path.endsWith('/batch')) {
        data = {'id':'batch',...jsonDecode(request.body) as Map<String,dynamic>};
      } else if (request.method == 'POST') {
        data = {'id':'new',...jsonDecode(request.body) as Map<String,dynamic>};
      }
      return http.Response(jsonEncode(data),200,headers:{'content-type':'application/json'});
    }));
  final repo = ApiMedicineRepository(api:api,localStore:MemoryInventoryLocalStore());
  await tester.pumpWidget(MaterialApp(locale:const Locale('zh','CN'),
    supportedLocales:const [Locale('zh','CN')],localizationsDelegates:GlobalMaterialLocalizations.delegates,
    home:MedicineDetailApiPage(repository:repo,workflow:ApiWorkflowRepository(api:api),medicineId:'medicine')));
  await tester.pumpAndSettle();
  return requests;
}
Finder field(String label) => find.byWidgetPredicate((w) => w is TextField && w.decoration?.labelText == label);
Future<void> tap(WidgetTester tester,String text) async {
  await tester.ensureVisible(find.text(text).first);
  await tester.tap(find.text(text).first);
  await tester.pumpAndSettle();
}
void main() {
  testWidgets('edit batch uses Chinese wheel and updates same batch', (tester) async {
    final requests = await open(tester);
    await tap(tester,'修改库存批次');
    await tester.enterText(field('数量（必填）'),'3');
    await tap(tester,'2027年12月31日');
    expect(find.byType(CupertinoDatePicker),findsOneWidget);
    tester.widget<CupertinoDatePicker>(find.byType(CupertinoDatePicker)).onDateTimeChanged(DateTime(2028,2,29));
    await tester.pump(); await tap(tester,'确定'); await tap(tester,'保存修改');
    final write = requests.singleWhere((r) => r.method == 'PUT');
    expect(write.url.path,endsWith('/batches/batch'));
    final payload = jsonDecode(write.body) as Map;
    expect(payload['quantity'],3); expect(payload['unit'],'tube');
    expect(payload['expiry'],{'value':'2028-02-29','precision':'day'});
    expect(payload['version'],2); expect(payload['lotNumber'],'OLD');
    expect(requests.where((r) => r.method == 'POST'),isEmpty);
  });
  testWidgets('new batch accepts mandatory fields without optional fields', (tester) async {
    final requests = await open(tester); await tap(tester,'新增一个批次');
    await tap(tester,'新增批次'); expect(find.byType(AlertDialog),findsOneWidget);
    await tap(tester,'知道了'); await tester.enterText(field('数量（必填）'),'1');
    await tap(tester,'新增批次'); expect(find.byType(AlertDialog),findsOneWidget);
    await tap(tester,'知道了'); await tap(tester,'选择年月日'); await tap(tester,'确定');
    await tap(tester,'新增批次');
    final payload = jsonDecode(requests.singleWhere((r) => r.method == 'POST').body) as Map;
    expect(payload['lotNumber'],isNull); expect(payload['storageLocation'],isNull);
    expect(payload['expiry']['precision'],'day');
  });
  testWidgets('purpose placeholder opens editable classification', (tester) async {
    final requests = await open(tester); await tap(tester,'用途待补充');
    await tap(tester,'过敏'); await tap(tester,'儿童'); await tap(tester,'保存分类');
    final payload = jsonDecode(requests.singleWhere((r) => r.method == 'PUT').body) as Map;
    expect(payload['purposeTags'],['allergy']); expect(payload['populationTags'],['child']);
    expect(payload['tagSource'],'user');
  });
}
