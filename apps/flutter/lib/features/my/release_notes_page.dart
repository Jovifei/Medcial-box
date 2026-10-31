import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/app_surfaces.dart';

/// 当前版本标识（与小程序 app-update.ts 的 APP_VERSION 保持一致）。
const String appVersion = '1.1.3';

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
    version: '1.1.3',
    date: '2026-10-28',
    items: [
      '药箱加载时明确显示进度，加载失败时提供重试。',
      '可以查看归档药品摘要，归档记录暂不支持恢复。',
    ],
  ),
  ReleaseNote(
    version: '1.1.1',
    date: '2026-10-27',
    items: [
      '药箱、用药计划和我的三个入口更清晰，家庭操作集中到家庭管理。',
      '录入和详情突出照片、库存与有效期，多个识别结果可逐图核对。',
      '识别后只展开需要核对的资料，低频字段、首页状态筛选和来源备份范围收纳清楚。',
    ],
  ),
  ReleaseNote(
    version: '1.0.6',
    date: '2026-10-25',
    items: [
      '拍照扫码只生成待核对候选；追溯码自动提取前段商品码查询，序列号不混入批号。',
      '导出与候选输出中文用途标签（含抗感染），按规格预填袋/支/粒等单位，尊重人工选择。',
      '家庭入口改为先选家庭一键进入，创建与邀请收起为次要入口；保存后自动清理未完成草稿。',
    ],
  ),
  ReleaseNote(
    version: '1.0.5',
    date: '2026-10-15',
    items: [
      '补拍保留原照片，保存全部图片，可选择最新正面作为封面。',
      '照片上传失败按原请求重试，旧草稿和家庭归属继续保留。',
      '统一版本记录并加强上线前回归，识别资料仍需本人核对。',
    ],
  ),
  ReleaseNote(
    version: '1.0.3',
    date: '2026-10-07',
    items: [
      '统一药品录入与日期交互，保留照片草稿和失败恢复。',
      '统一药箱筛选、已处理库存与待补资料口径。',
      '收紧发布、网络与本机试用边界，完善最终交付门禁。',
    ],
  ),
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
