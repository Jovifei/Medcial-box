import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';

/// 当前版本标识（与小程序 app-update.ts 的 APP_VERSION 保持一致）。
const String appVersion = '0.2.0-s0s1r1';

class ReleaseNote {
  const ReleaseNote({
    required this.version,
    required this.date,
    required this.items,
  });
  final String version;
  final String date;
  final List<String> items;
}

const List<ReleaseNote> releaseNotes = [
  ReleaseNote(
    version: '0.2.0-s0s1r1',
    date: '2026-10-01',
    items: [
      '新增用药计划：照护对象、每日时间点、今日安排与服用确认，纠正会保留操作历史。',
      '数量支持毫升（最多三位小数）与“板”，切换单位不再自动换算旧数字。',
      '补齐会话切换、导出与草稿保护；更新前会先处理未保存内容。',
    ],
  ),
];

/// 版本与更新说明（S5-D）：Flutter 端展示当前版本与近期重点改进。
class ReleaseNotesPage extends StatelessWidget {
  const ReleaseNotesPage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('版本与更新')),
    body: AppPage(
      child: ListView(
        children: [
          AppCard(
            color: AppColors.mist,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '当前版本 $appVersion',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 6),
                const Text(
                  '应用内不自动重启或强制更新。如需检查更新，请通过你获取本应用的分发渠道。',
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          ...releaseNotes.map(
            (note) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            note.version,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                        if (note.version == appVersion)
                          const Text(
                            '当前',
                            style: TextStyle(
                              color: AppColors.leafDeep,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                      ],
                    ),
                    Text(
                      note.date,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 8),
                    ...note.items.map(
                      (item) => Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Text('· $item'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}
