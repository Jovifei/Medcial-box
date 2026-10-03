import 'package:flutter/material.dart';

const medicinePopulationLabels = {'adult': '成人', 'child': '儿童'};
const medicinePurposeLabels = {
  'fever': '发热',
  'cough': '咳嗽',
  'throat': '咽喉',
  'nasal': '鼻部',
  'gastro': '胃肠',
  'pain': '疼痛',
  'topical': '外用',
  'allergy': '过敏',
  'other': '其他',
};

class MedicineTagFields extends StatelessWidget {
  const MedicineTagFields({
    super.key,
    required this.populations,
    required this.purposes,
    required this.onChanged,
  });
  final Set<String> populations;
  final Set<String> purposes;
  final VoidCallback onChanged;
  Widget _choices(Map<String, String> labels, Set<String> selected) => Wrap(
    spacing: 8,
    runSpacing: 6,
    children: [
      for (final entry in labels.entries)
        FilterChip(
          label: Text(entry.value),
          selected: selected.contains(entry.key),
          onSelected: (value) {
            value ? selected.add(entry.key) : selected.remove(entry.key);
            onChanged();
          },
        ),
    ],
  );
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text('用途标签（按包装/说明书核对）'),
      _choices(medicinePurposeLabels, purposes),
      const SizedBox(height: 10),
      const Text('人群标签（仅按包装/说明书确认）'),
      _choices(medicinePopulationLabels, populations),
      const Text('标签用于整理和筛选，不代表适合任何人服用。未确认时可以不选。'),
    ],
  );
}
