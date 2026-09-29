import 'dart:typed_data';

import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

Future<Uint8List> buildInventoryPdf(String markdown, ByteData fontBytes) async {
  final font = pw.Font.ttf(fontBytes);
  final document = pw.Document(title: '家庭药箱库存清单', subject: '家庭药品库存管理记录');
  final lines = markdown.split(RegExp(r'\r?\n'));

  document.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a4,
      margin: const pw.EdgeInsets.fromLTRB(38, 42, 38, 42),
      theme: pw.ThemeData.withFont(base: font, bold: font),
      build: (_) => [
        for (final rawLine in lines)
          if (rawLine.trim().isEmpty)
            pw.SizedBox(height: 7)
          else if (rawLine.startsWith('# '))
            pw.Padding(
              padding: const pw.EdgeInsets.only(bottom: 12),
              child: pw.Text(
                rawLine.substring(2),
                style: pw.TextStyle(
                  fontSize: 21,
                  fontWeight: pw.FontWeight.bold,
                ),
              ),
            )
          else if (rawLine.startsWith('## '))
            pw.Padding(
              padding: const pw.EdgeInsets.only(top: 8, bottom: 5),
              child: pw.Text(
                rawLine.substring(3),
                style: pw.TextStyle(
                  fontSize: 15,
                  fontWeight: pw.FontWeight.bold,
                ),
              ),
            )
          else if (rawLine.startsWith('### '))
            pw.Padding(
              padding: const pw.EdgeInsets.only(top: 6, bottom: 3),
              child: pw.Text(
                rawLine.substring(4),
                style: pw.TextStyle(
                  fontSize: 12,
                  fontWeight: pw.FontWeight.bold,
                ),
              ),
            )
          else
            pw.Padding(
              padding: const pw.EdgeInsets.only(bottom: 3),
              child: pw.Text(
                rawLine.replaceFirst(RegExp(r'^\s*-\s*'), '• '),
                style: const pw.TextStyle(fontSize: 10.5, lineSpacing: 2),
              ),
            ),
      ],
    ),
  );
  return document.save();
}
