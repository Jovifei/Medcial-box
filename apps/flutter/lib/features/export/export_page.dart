import 'package:flutter/material.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../data/demo_repositories.dart';

class ExportPage extends StatefulWidget {
  const ExportPage({super.key, required this.repository});
  final DemoMedicineRepository repository;

  @override
  State<ExportPage> createState() => _ExportPageState();
}

class _ExportPageState extends State<ExportPage> {
  bool includeDose = false;
  bool includeArchived = false;
  bool includeStorage = true;

  String get markdown =>
      '''# 家庭药箱清单

> 导出时间：演示原型

## 在用库存

${widget.repository.medicines.map((medicine) => '- **${medicine.name}**｜${medicine.specification}｜用途：${medicine.purpose}').join('\n')}

## 导出选项

- 个人剂量备注：${includeDose ? '包含' : '不包含'}
- 归档记录：${includeArchived ? '包含' : '不包含'}
- 存放位置：${includeStorage ? '包含' : '不包含'}
''';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('导出 Markdown')),
      body: AppPage(
        child: ListView(
          children: [
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('导出前确认', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 12),
                  SwitchListTile.adaptive(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('包含个人剂量备注'),
                    subtitle: const Text('默认关闭，避免把私人备注交给外部 AI'),
                    value: includeDose,
                    onChanged: (value) => setState(() => includeDose = value),
                  ),
                  SwitchListTile.adaptive(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('包含归档记录'),
                    value: includeArchived,
                    onChanged: (value) =>
                        setState(() => includeArchived = value),
                  ),
                  SwitchListTile.adaptive(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('包含存放位置'),
                    value: includeStorage,
                    onChanged: (value) =>
                        setState(() => includeStorage = value),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            AppCard(
              color: Colors.white,
              child: SelectableText(
                markdown,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  height: 1.55,
                  color: Color(0xFF3A473F),
                ),
              ),
            ),
            const SizedBox(height: 16),
            PrimaryButton(
              label: '复制文本（演示）',
              icon: Icons.copy_rounded,
              onPressed: () => ScaffoldMessenger.of(context)
                  .showSnackBar(const SnackBar(content: Text('演示原型：复制动作已触发'))),
            ),
          ],
        ),
      ),
    );
  }
}
