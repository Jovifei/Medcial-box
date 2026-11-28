import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:home_medicine_flutter/data/api_client.dart';
import 'package:home_medicine_flutter/data/api_plan_repository.dart';
import 'package:home_medicine_flutter/features/plan/plans_page.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  for (final width in [320.0, 390.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('plan date and bottom content at $width / $scale', (
        tester,
      ) async {
        tester.view.physicalSize = Size(width, 700);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final api = ApiClient(
          baseUrl: 'https://synthetic.invalid',
          tokenProvider: () async => 'synthetic',
          client: MockClient(
            (request) async => http.Response(
              jsonEncode(
                request.url.path.endsWith('/schedule')
                    ? {
                        'date': '2026-11-09',
                        'entries': [
                          for (var i = 0; i < 8; i++)
                            {
                              'occurrenceId': 'synthetic-dose-$i',
                              'planId': 'synthetic-plan-$i',
                              'careProfileId': 'synthetic-profile',
                              'careProfileName': '家人',
                              'medicineName': '合成计划$i',
                              'dosageText': '按计划记录',
                              'time': '08:30',
                              'status': 'taken',
                            },
                        ],
                      }
                    : {'plans': []},
              ),
              200,
              headers: {'content-type': 'application/json'},
            ),
          ),
        );
        final repository = ApiPlanRepository(api: api);
        addTearDown(repository.dispose);
        addTearDown(api.close);
        await tester.pumpWidget(
          MaterialApp(
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: PlansPage(repository: repository),
          ),
        );
        await tester.pumpAndSettle();
        const date = '2026-11-09';
        final label = find.textContaining('今日安排 · $date');
        expect(label, findsOneWidget);
        final paragraph = tester.renderObject<RenderParagraph>(label);
        final text = paragraph.text.toPlainText();
        final start = text.indexOf(date);
        expect(start, greaterThanOrEqualTo(0));
        final boxes = paragraph.getBoxesForSelection(
          TextSelection(baseOffset: start, extentOffset: start + date.length),
        );
        expect(
          boxes.map((box) => box.top.round()).toSet().length,
          1,
          reason: 'the date must not break across lines',
        );
        final content = find.text('合成计划7');
        await tester.scrollUntilVisible(
          content,
          300,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.drag(find.byType(ListView), const Offset(0, -3000));
        await tester.pumpAndSettle();
        final finalDetail = find.text('家人 · 08:30 · 按计划记录').last;
        expect(finalDetail, findsOneWidget);
        expect(
          tester
              .state<ScrollableState>(find.byType(Scrollable).first)
              .position
              .extentAfter,
          0,
        );
        expect(tester.getRect(finalDetail).top, greaterThanOrEqualTo(0));
        expect(tester.getRect(finalDetail).bottom, lessThanOrEqualTo(700));
        expect(
          tester.getSize(find.byType(FloatingActionButton)).height,
          greaterThanOrEqualTo(48),
        );
        expect(
          tester
              .getRect(finalDetail)
              .overlaps(tester.getRect(find.byType(FloatingActionButton))),
          isFalse,
        );
        expect(tester.takeException(), isNull);
      });
    }
  }
}
