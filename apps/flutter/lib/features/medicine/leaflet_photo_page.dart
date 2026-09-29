import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_workflow_repository.dart';

abstract interface class LeafletImagePicker {
  Future<XFile?> pickImage(ImageSource source);
}

class PluginLeafletImagePicker implements LeafletImagePicker {
  PluginLeafletImagePicker({ImagePicker? picker})
    : _picker = picker ?? ImagePicker();
  final ImagePicker _picker;

  @override
  Future<XFile?> pickImage(ImageSource source) =>
      _picker.pickImage(source: source, imageQuality: 90, maxWidth: 2200);
}

class LeafletPhotoPage extends StatefulWidget {
  const LeafletPhotoPage({
    super.key,
    required this.medicineId,
    required this.repository,
    this.imagePicker,
  });

  final String medicineId;
  final ApiWorkflowRepository repository;
  final LeafletImagePicker? imagePicker;

  @override
  State<LeafletPhotoPage> createState() => _LeafletPhotoPageState();
}

class _LeafletPhotoPageState extends State<LeafletPhotoPage> {
  late final LeafletImagePicker _imagePicker =
      widget.imagePicker ?? PluginLeafletImagePicker();
  List<LeafletPhotoRecord> photos = const [];
  Object? failure;
  bool loading = true;
  bool uploading = false;
  String? viewingPhotoId;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final result = await widget.repository.listLeafletPhotos(
        widget.medicineId,
      );
      if (mounted) {
        setState(() {
          photos = result;
          failure = null;
          loading = false;
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          failure = error;
          loading = false;
        });
      }
    }
  }

  Future<void> _chooseAndUpload() async {
    if (uploading) return;
    final source = await showAppSheet<ImageSource>(
      context,
      title: '添加说明书照片',
      builder: (sheetContext) => Column(
        children: [
          choiceTile(
            sheetContext,
            icon: Icons.camera_alt_outlined,
            title: '拍摄说明书照片',
            subtitle: '先拍摄，确认上传后才会保存到家庭药箱',
            onTap: () => Navigator.pop(sheetContext, ImageSource.camera),
          ),
          const SizedBox(height: 10),
          choiceTile(
            sheetContext,
            icon: Icons.photo_library_outlined,
            title: '从相册选择',
            subtitle: '选择包装内说明书的清晰照片',
            onTap: () => Navigator.pop(sheetContext, ImageSource.gallery),
          ),
        ],
      ),
    );
    if (source == null || !mounted) return;

    XFile? selected;
    try {
      selected = await _imagePicker.pickImage(source);
    } catch (error) {
      if (mounted) _showError(_pickerError(error));
      return;
    }
    if (selected == null || !mounted) return;

    Uint8List bytes;
    String mimeType;
    try {
      bytes = await selected.readAsBytes();
      mimeType = _imageMimeType(bytes);
      if (bytes.length > 8 * 1024 * 1024) {
        throw const FormatException('图片超过 8 MB，请缩小后重新选择。');
      }
    } catch (error) {
      if (mounted) {
        _showError(
          error is FormatException ? error.message : '无法读取这张图片，请重新选择。',
        );
      }
      return;
    }
    if (!mounted) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('确认上传说明书照片'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 260,
                height: 170,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.memory(
                    bytes,
                    fit: BoxFit.contain,
                    semanticLabel: '待上传的说明书照片预览',
                  ),
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                '照片将保存在家庭药箱的私有存储中，已加入该家庭的成员都可以查看。此流程不会把照片发送给 AI 或药品查询服务。请先确认照片中没有不希望家人看到的信息。',
              ),
              const SizedBox(height: 8),
              Text(
                '${mimeType == 'image/png' ? 'PNG' : 'JPEG'} · ${_sizeLabel(bytes.length)}',
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('暂不上传'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('上传到家庭药箱'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() {
      uploading = true;
      failure = null;
    });
    try {
      final uploaded = await widget.repository.uploadLeafletPhoto(
        widget.medicineId,
        bytes,
        mimeType: mimeType,
      );
      if (!mounted) return;
      setState(() => photos = [uploaded, ...photos]);
      _showMessage('说明书照片已保存到家庭药箱。');
    } catch (error) {
      if (mounted) _showError(error);
    } finally {
      if (mounted) setState(() => uploading = false);
    }
  }

  Future<void> _view(LeafletPhotoRecord photo) async {
    if (viewingPhotoId != null) return;
    setState(() => viewingPhotoId = photo.id);
    try {
      final image = await widget.repository.readLeafletPhoto(
        widget.medicineId,
        photo.id,
      );
      if (!mounted) return;
      if (!const {'image/jpeg', 'image/png'}.contains(image.contentType)) {
        throw const FormatException('服务器返回的图片格式无法显示。');
      }
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => Dialog.fullscreen(
          child: Scaffold(
            appBar: AppBar(
              title: const Text('说明书图片'),
              leading: IconButton(
                tooltip: '关闭',
                onPressed: () => Navigator.pop(dialogContext),
                icon: const Icon(Icons.close_rounded),
              ),
            ),
            body: Center(
              child: InteractiveViewer(
                child: Image.memory(
                  image.bytes,
                  fit: BoxFit.contain,
                  semanticLabel: '家庭药箱说明书照片',
                ),
              ),
            ),
          ),
        ),
      );
    } catch (error) {
      if (mounted) {
        _showError(
          error is FormatException ? error.message : friendlyApiError(error),
        );
      }
    } finally {
      if (mounted) setState(() => viewingPhotoId = null);
    }
  }

  Future<void> _delete(LeafletPhotoRecord photo) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除这张说明书照片？'),
        content: const Text('照片会从家庭药箱列表隐藏，不会影响药品和库存记录。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('删除照片'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => uploading = true);
    try {
      await widget.repository.deleteLeafletPhoto(widget.medicineId, photo.id);
      if (mounted) {
        setState(
          () => photos = photos.where((item) => item.id != photo.id).toList(),
        );
        _showMessage('说明书照片已删除。');
      }
    } catch (error) {
      if (mounted) _showError(error);
    } finally {
      if (mounted) setState(() => uploading = false);
    }
  }

  String _pickerError(Object error) {
    final normalized = error.toString().toLowerCase();
    if (normalized.contains('permission') || normalized.contains('denied')) {
      return '相机或相册权限未开启。你也可以到系统设置中允许访问后重试。';
    }
    return '无法打开相机或相册，请重试。';
  }

  void _showMessage(String message) =>
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));

  void _showError(Object error) => _showMessage(friendlyApiError(error));

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('说明书照片')),
    body: AppPage(
      padding: const EdgeInsets.fromLTRB(18, 8, 18, 24),
      child: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            AppCard(
              color: const Color(0xFFE8F1EA),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '只保存你确认的照片',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    '拍照或选图后会先预览并再次征求确认。照片保存在家庭药箱私有存储，家庭成员可查看；不会自动识别或上传给外部 AI。',
                  ),
                  const SizedBox(height: 12),
                  PrimaryButton(
                    label: uploading ? '正在处理…' : '拍摄或选择说明书照片',
                    icon: Icons.add_a_photo_outlined,
                    onPressed: uploading ? null : _chooseAndUpload,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            if (loading)
              const AppCard(
                child: Center(
                  child: CircularProgressIndicator(semanticsLabel: '正在加载说明书照片'),
                ),
              )
            else if (failure != null)
              AppCard(
                child: Column(
                  children: [
                    Text('照片列表暂时无法加载：${friendlyApiError(failure!)}'),
                    const SizedBox(height: 8),
                    SoftButton(label: '重试', onPressed: _load),
                  ],
                ),
              )
            else if (photos.isEmpty)
              const AppCard(child: Center(child: Text('还没有说明书照片')))
            else ...[
              Text(
                '已保存照片 · ${photos.length}',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              ...photos.map(
                (photo) => AppCard(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  child: ListTile(
                    leading: const CircleAvatar(
                      child: Icon(Icons.description_outlined),
                    ),
                    title: Text(_sourceLabel(photo.source)),
                    subtitle: Text(
                      '${_dateLabel(photo.createdAt)} · ${_sizeLabel(photo.sizeBytes)}',
                    ),
                    onTap: viewingPhotoId == null ? () => _view(photo) : null,
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          tooltip: '查看说明书照片',
                          onPressed: viewingPhotoId == null
                              ? () => _view(photo)
                              : null,
                          icon: const Icon(Icons.visibility_outlined),
                        ),
                        IconButton(
                          tooltip: '删除说明书照片',
                          onPressed: uploading ? null : () => _delete(photo),
                          icon: const Icon(Icons.delete_outline_rounded),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    ),
  );
}

String _imageMimeType(Uint8List bytes) {
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= pngSignature.length) {
    var isPng = true;
    for (var index = 0; index < pngSignature.length; index++) {
      if (bytes[index] != pngSignature[index]) {
        isPng = false;
        break;
      }
    }
    if (isPng) return 'image/png';
  }
  if (bytes.length >= 3 &&
      bytes[0] == 0xff &&
      bytes[1] == 0xd8 &&
      bytes[2] == 0xff) {
    return 'image/jpeg';
  }
  throw const FormatException('仅支持有效的 JPEG 或 PNG 图片。');
}

String _sourceLabel(String source) => switch (source) {
  'package_leaflet' => '包装说明书',
  'package' => '药品包装',
  _ => '家庭补充资料',
};

String _dateLabel(String value) =>
    value.length >= 10 ? value.substring(0, 10) : value;

String _sizeLabel(int bytes) => bytes >= 1024 * 1024
    ? '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB'
    : '${(bytes / 1024).ceil()} KB';
