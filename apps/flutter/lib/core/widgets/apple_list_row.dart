import 'package:flutter/cupertino.dart';

import '../theme/app_typography.dart';

/// A grouped settings row whose text can grow with Dynamic Type.
///
/// CupertinoListTile intentionally keeps its title and subtitle on one line.
/// These rows hold instructions and family names that must remain readable at
/// large text sizes, while keeping the native Cupertino pressed feedback.
class AppleListRow extends StatelessWidget {
  const AppleListRow({
    required this.title,
    this.subtitle,
    this.additionalInfo,
    this.leading,
    this.trailing,
    this.onTap,
    this.selected,
    super.key,
  });

  final Widget title;
  final Widget? subtitle;
  final Widget? additionalInfo;
  final Widget? leading;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool? selected;

  @override
  Widget build(BuildContext context) {
    final secondary = CupertinoColors.secondaryLabel.resolveFrom(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        // Long action labels get their own line; chevrons and switches retain
        // their familiar position next to the title at every text size.
        final actionBelow =
            trailing is CupertinoButton &&
            (constraints.maxWidth < 320 ||
                MediaQuery.textScalerOf(context).scale(15) > 20);
        final content = ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    if (leading != null) ...[
                      IconTheme(
                        data: IconThemeData(
                          color: CupertinoTheme.of(context).primaryColor,
                          size: 22,
                        ),
                        child: SizedBox(width: 28, child: leading),
                      ),
                      const SizedBox(width: 12),
                    ],
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          DefaultTextStyle.merge(
                            style: AppType.body.copyWith(
                              color: CupertinoColors.label.resolveFrom(context),
                            ),
                            child: title,
                          ),
                          if (subtitle != null) ...[
                            const SizedBox(height: 4),
                            DefaultTextStyle.merge(
                              style: AppType.subhead.copyWith(color: secondary),
                              child: subtitle!,
                            ),
                          ],
                          if (additionalInfo != null) ...[
                            const SizedBox(height: 4),
                            DefaultTextStyle.merge(
                              style: AppType.subhead.copyWith(color: secondary),
                              child: additionalInfo!,
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (trailing != null && !actionBelow) ...[
                      const SizedBox(width: 12),
                      trailing!,
                    ],
                  ],
                ),
                if (actionBelow)
                  Align(alignment: Alignment.centerRight, child: trailing!),
              ],
            ),
          ),
        );
        return Semantics(
          selected: selected,
          child: onTap == null
              ? content
              : CupertinoButton(
                  padding: EdgeInsets.zero,
                  minimumSize: const Size(48, 48),
                  alignment: Alignment.centerLeft,
                  onPressed: onTap,
                  child: content,
                ),
        );
      },
    );
  }
}
