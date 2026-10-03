import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

Future<DateTime?> showExpiryDateWheelPicker(
  BuildContext context, {
  required DateTime initialDate,
}) => showModalBottomSheet<DateTime>(
  context: context,
  useSafeArea: true,
  builder: (_) => _ExpiryDateWheelPicker(initialDate: initialDate),
);

DateTime expiryDateForPicker(String value) {
  final match = RegExp(r'^(\d{4})-(\d{2})(?:-(\d{2}))?$').firstMatch(value);
  if (match == null) return DateTime.now();
  final year = int.parse(match.group(1)!);
  final month = int.parse(match.group(2)!);
  final day = int.parse(match.group(3) ?? '1');
  if (year < 1900 ||
      year > 2200 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31) {
    return DateTime.now();
  }
  final date = DateTime(year, month, day);
  if (date.year != year || date.month != month || date.day != day) {
    return DateTime.now();
  }
  return date;
}

String formatExpiryDate(DateTime date, {required String precision}) {
  final year = date.year.toString().padLeft(4, '0');
  final month = date.month.toString().padLeft(2, '0');
  if (precision == 'month') return '$year-$month';
  return '$year-$month-${date.day.toString().padLeft(2, '0')}';
}

String displayExpiryDate(String value) {
  final match = RegExp(r'^(\d{4})-(\d{2})(?:-(\d{2}))?$').firstMatch(value);
  if (match == null) return value;
  final date = expiryDateForPicker(value);
  final year = int.parse(match.group(1)!);
  final month = int.parse(match.group(2)!);
  final day = match.group(3) == null ? null : int.parse(match.group(3)!);
  if (date.year != year || date.month != month || date.day != (day ?? 1)) {
    return value;
  }
  return day == null ? '$year年$month月' : '$year年$month月$day日';
}

class _ExpiryDateWheelPicker extends StatefulWidget {
  const _ExpiryDateWheelPicker({required this.initialDate});

  final DateTime initialDate;

  @override
  State<_ExpiryDateWheelPicker> createState() => _ExpiryDateWheelPickerState();
}

class _ExpiryDateWheelPickerState extends State<_ExpiryDateWheelPicker> {
  late DateTime selectedDate = DateTime(
    widget.initialDate.year,
    widget.initialDate.month,
    widget.initialDate.day,
  );

  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surface,
    borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
    clipBehavior: Clip.antiAlias,
    child: SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('取消'),
                ),
                Text('选择有效期', style: Theme.of(context).textTheme.titleMedium),
                TextButton(
                  onPressed: () => Navigator.pop(context, selectedDate),
                  child: const Text('确定'),
                ),
              ],
            ),
          ),
          SizedBox(
            height: 216,
            child: Localizations.override(
              context: context,
              locale: const Locale('zh', 'CN'),
              child: CupertinoDatePicker(
                mode: CupertinoDatePickerMode.date,
                dateOrder: DatePickerDateOrder.ymd,
                initialDateTime: selectedDate,
                onDateTimeChanged: (value) =>
                    setState(() => selectedDate = value),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}
