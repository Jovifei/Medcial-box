import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../data/api_client.dart';
import '../../data/api_workflow_repository.dart';
import '../../models/medicine_models.dart';

const _evidenceLabels = <String, String>{
  'name': '药名',
  'brand': '品牌',
  'specification': '规格',
  'manufacturer': '厂家',
  'approvalNumber': '批准文号',
  'barcodeValue': '条码',
  'activeIngredients': '成分',
  'purposeCategory': '用途分类',
  'lotNumber': '批号',
  'expiryValue': '有效期',
  'expiryPrecision': '有效期精度',
  'populationTags': '人群',
  'purposeTags': '用途',
  'leafletText': '说明书原文',
  'rawOcrText': '本机识别原文',
  'purposeSummary': '功能与用途',
  'packageUsageSummary': '用法用量原文',
  'contraindicationsSummary': '禁忌',
  'precautionsSummary': '注意事项',
};

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
    this.onPhotosChanged,
  });

  final String medicineId;
  final ApiWorkflowRepository repository;
  final LeafletImagePicker? imagePicker;
  final VoidCallback? onPhotosChanged;

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
  RecognitionEvidence? evidence;
  bool evidenceUnavailable = false;
  late final Object _identity = _identitySnapshot();
  late final Listenable _identitySignals = Listenable.merge([
    widget.repository.api.identityEpochSignal,
    if (widget.repository.api.identityState != null)
      widget.repository.api.identityState!.scopeSignal,
  ]);
  int _loadGeneration = 0;

  Object _identitySnapshot() => (
    widget.repository.api.identityEpoch,
    widget.repository.api.identityState?.generation,
    widget.repository.api.identityState?.owner?.userId,
    widget.repository.api.identityState?.owner?.familyId,
  );
  bool get _current => mounted && _identity == _identitySnapshot();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final generation = ++_loadGeneration;
    bool current() => _current && generation == _loadGeneration;
    try {
      final result = await widget.repository.listLeafletPhotos(
        widget.medicineId,
        isCurrent: current,
      );
      RecognitionEvidence? loadedEvidence;
      var unavailable = false;
      try {
        loadedEvidence = await widget.repository.getRecognitionEvidence(
          widget.medicineId,
          isCurrent: current,
        );
      } catch (_) {
        unavailable = true;
      }
      if (current()) {
        setState(() {
          photos = result;
          evidence = loadedEvidence;
          evidenceUnavailable = unavailable;
          failure = null;
          loading = false;
        });
      }
    } catch (error) {
      if (current()) {
        setState(() {
          failure = error;
          loading = false;
        });
      }
    }
  }

  Future<void> _chooseAndUpload() async {
    if (uploading || !_current) return;
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
    if (source == null || !_current) return;

    XFile? selected;
    try {
      selected = await _imagePicker.pickImage(source);
    } catch (error) {
      if (_current) _showError(_pickerError(error));
      return;
    }
    if (selected == null || !_current) return;

    Uint8List bytes;
    String mimeType;
    try {
      bytes = await selected.readAsBytes();
      mimeType = _imageMimeType(bytes);
      if (bytes.length > 8 * 1024 * 1024) {
        throw const FormatException('图片超过 8 MB，请缩小后重新选择。');
      }
    } catch (error) {
      if (_current) {
        _showError(
          error is FormatException ? error.message : '无法读取这张图片，请重新选择。',
        );
      }
      return;
    }
    if (!mounted || !_current) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AnimatedBuilder(
        animation: _identitySignals,
        builder: (_, _) => !_current
            ? AlertDialog(
                title: const Text('家庭身份已变化'),
                content: const Text('照片预览已隐藏，请重新打开照片资料。'),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(dialogContext, false),
                    child: const Text('关闭'),
                  ),
                ],
              )
            : AlertDialog(
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
      ),
    );
    if (confirmed != true || !_current) return;

    setState(() {
      uploading = true;
      failure = null;
    });
    try {
      final uploaded = await widget.repository.uploadLeafletPhoto(
        widget.medicineId,
        bytes,
        mimeType: mimeType,
        isCurrent: () => _current,
      );
      if (!mounted || !_current) return;
      widget.onPhotosChanged?.call();
      setState(() => photos = [uploaded, ...photos]);
      _showMessage('说明书照片已保存到家庭药箱。');
    } catch (error) {
      if (_current) _showError(error);
    } finally {
      if (_current) setState(() => uploading = false);
    }
  }

  Future<void> _view(LeafletPhotoRecord photo) => _viewById(photo.id);

  Future<void> _viewById(String photoId) async {
    if (viewingPhotoId != null || !_current) return;
    setState(() => viewingPhotoId = photoId);
    try {
      final image = await widget.repository.readLeafletPhoto(
        widget.medicineId,
        photoId,
        isCurrent: () => _current,
      );
      if (!mounted || !_current) return;
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
            body: AnimatedBuilder(
              animation: _identitySignals,
              builder: (context, _) => !_current
                  ? const Center(child: Text('家庭身份已变化，原图已关闭。'))
                  : Center(
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
        ),
      );
    } catch (error) {
      if (_current) {
        _showError(
          error is FormatException ? error.message : friendlyApiError(error),
        );
      }
    } finally {
      if (_current) setState(() => viewingPhotoId = null);
    }
  }

  Future<void> _delete(LeafletPhotoRecord photo) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除这张说明书照片？'),
        content: const Text('已保存资料保留，原图将不可查看。不会影响药品和库存记录。'),
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
    if (confirmed != true || !_current) return;
    setState(() => uploading = true);
    try {
      await widget.repository.deleteLeafletPhoto(
        widget.medicineId,
        photo.id,
        isCurrent: () => _current,
      );
      if (_current) {
        widget.onPhotosChanged?.call();
        setState(
          () => photos = photos.where((item) => item.id != photo.id).toList(),
        );
        _showMessage('说明书照片已删除。');
        unawaited(_load());
      }
    } catch (error) {
      if (_current) _showError(error);
    } finally {
      if (_current) setState(() => uploading = false);
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
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _identitySignals,
    builder: (context, _) => !_current
        ? const Scaffold(body: Center(child: Text('家庭身份已变化，请重新打开照片资料。')))
        : _buildPage(context),
  );

  Widget _buildPage(BuildContext context) => Scaffold(
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
            if (!loading && evidenceUnavailable)
              const AppCard(child: Text('逐图来源暂不可用或旧服务未记录；照片仍可查看。'))
            else if (!loading && evidence == null)
              const AppCard(child: Text('未记录逐图来源。'))
            else if (!loading && evidence != null) ...[
              if (evidence!.stale)
                const AppCard(child: Text('药品资料已变化，请重新核对来源。')),
              for (final photo in evidence!.photos)
                AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '图${photo.sequence} · ${photo.available ? '原图可查看' : '原图不可查看'}',
                      ),
                      Text(
                        photo.status == 'recognized'
                            ? '已识别，内容需核对'
                            : photo.status == 'failed'
                            ? '识别失败'
                            : '待读取',
                      ),
                      for (final entry in photo.fields.entries)
                        Text(
                          '${_evidenceLabels[entry.key] ?? entry.key}：${entry.value is List ? (entry.value as List).join('、') : entry.value ?? '未记录'}',
                        ),
                      for (final warning in photo.warnings ?? const <String>[])
                        Text('识别提醒：$warning'),
                      if (photo.available)
                        TextButton.icon(
                          onPressed: viewingPhotoId == null
                              ? () => _viewById(photo.photoId)
                              : null,
                          icon: const Icon(Icons.visibility_outlined),
                          label: Text('查看图${photo.sequence}原图'),
                        )
                      else
                        const Text('原图不可查看，识别资料仍保留。'),
                      for (final entry in evidence!.fieldSources.entries)
                        if (entry.value.photoIds.contains(photo.photoId))
                          Text(
                            '${_evidenceLabels[entry.key] ?? entry.key}：来自图${photo.sequence} · ${entry.value.reviewed ? '已核对' : '待核对'}',
                          ),
                    ],
                  ),
                ),
              for (final entry in evidence!.fieldSources.entries)
                if (entry.value.source == 'removed')
                  Text(
                    '${_evidenceLabels[entry.key] ?? entry.key}：原图已移除，已保存资料保留',
                  ),
              for (final source in evidence!.batchSources)
                Text(
                  '${source.field == 'expiry' ? '批次有效期' : '批号'}：${source.batchAvailable ? (source.source == 'recognized'
                            ? '照片识别${source.reviewed ? ' · 已核对' : ' · 待核对'}'
                            : source.source == 'manual'
                            ? '人工填写或清空'
                            : source.source == 'removed'
                            ? '原图已移除'
                            : '目录候选') : '所属批次不可核验'}',
                ),
            ],
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
