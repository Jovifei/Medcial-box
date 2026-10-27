import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../data/api_client.dart';

typedef _ImageKey = (String, int, String, String, int, int);

class _ImageEntry {
  late Future<Uint8List?> future;
  Uint8List? bytes;
}

/// A bounded cache owned by one app instance and one authenticated API client.
class PrivateMedicineImageLoader extends ChangeNotifier {
  PrivateMedicineImageLoader(this.api) {
    api.identityEpochSignal.addListener(_invalidate);
    api.identityState?.scopeSignal.addListener(_invalidate);
  }

  final ApiClient api;
  final _entries = <_ImageKey, _ImageEntry>{};
  int _revision = 0;
  int _bytes = 0;
  static const _maxEntries = 24;
  static const _maxBytes = 24 * 1024 * 1024;

  String? get _scope {
    final owner = api.identityState?.owner;
    if (owner == null ||
        owner.familyId == null ||
        owner.origin != api.baseUrl) {
      return null;
    }
    return api.identityState!.scopeSignal.value;
  }

  void _evict(_ImageKey key, _ImageEntry entry) {
    final bytes = entry.bytes;
    if (bytes == null) return;
    _bytes -= bytes.length;
    // Supplying only one decode dimension preserves the original aspect ratio.
    ResizeImage(MemoryImage(bytes), width: key.$5).evict();
  }

  void _invalidate() {
    _revision++;
    for (final item in _entries.entries) {
      _evict(item.key, item.value);
    }
    _entries.clear();
    notifyListeners();
  }

  /// Called after a photo mutation so even an in-flight older read is rejected.
  void invalidatePhotos() => _invalidate();

  Future<Uint8List?> load({
    required String medicineId,
    required String photoId,
    required int width,
    required int height,
  }) {
    final scope = _scope;
    if (scope == null) return Future.value(null);
    final epoch = api.identityEpoch;
    final revision = _revision;
    final key = (scope, epoch, medicineId, photoId, width, height);
    final old = _entries.remove(key);
    if (old != null) {
      _entries[key] = old;
      return old.future;
    }
    bool current() =>
        _revision == revision && api.identityEpoch == epoch && _scope == scope;
    final entry = _ImageEntry();
    _entries[key] = entry;
    entry.future = () async {
      try {
        final photo = await api.getBinary(
          '/api/v1/medicines/$medicineId/leaflet-photos/$photoId',
          isCurrent: current,
        );
        if (!current()) return null;
        if (identical(_entries[key], entry)) {
          if (photo.bytes.length <= _maxBytes) {
            entry.bytes = photo.bytes;
            _bytes += photo.bytes.length;
            _trim();
          } else {
            _entries.remove(key);
          }
        }
        return photo.bytes;
      } catch (_) {
        if (identical(_entries[key], entry)) _entries.remove(key);
        return null;
      }
    }();
    _trim();
    return entry.future;
  }

  void _trim() {
    while (_entries.length > _maxEntries || _bytes > _maxBytes) {
      final key = _entries.keys.first;
      _evict(key, _entries.remove(key)!);
    }
  }

  @override
  void dispose() {
    api.identityEpochSignal.removeListener(_invalidate);
    api.identityState?.scopeSignal.removeListener(_invalidate);
    for (final item in _entries.entries) {
      _evict(item.key, item.value);
    }
    _entries.clear();
    _revision++;
    super.dispose();
  }
}

class PrivateMedicineImage extends StatefulWidget {
  const PrivateMedicineImage({
    super.key,
    required this.loader,
    required this.medicineId,
    required this.photoId,
    required this.width,
    required this.height,
    this.fit = BoxFit.contain,
    this.onTap,
  });

  final PrivateMedicineImageLoader loader;
  final String medicineId;
  final String? photoId;
  final double width;
  final double height;
  final BoxFit fit;
  final VoidCallback? onTap;

  @override
  State<PrivateMedicineImage> createState() => _PrivateMedicineImageState();
}

class _PrivateMedicineImageState extends State<PrivateMedicineImage> {
  Future<Uint8List?>? _future;
  int _request = 0;
  int? _decodeWidth;
  int? _decodeHeight;
  ImageProvider? _displayedProvider;

  @override
  void initState() {
    super.initState();
    widget.loader.addListener(_changed);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final ratio = MediaQuery.devicePixelRatioOf(context);
    final width = (widget.width * ratio).ceil();
    final height = (widget.height * ratio).ceil();
    if (_decodeWidth != width || _decodeHeight != height) {
      _decodeWidth = width;
      _decodeHeight = height;
      _start();
    }
  }

  @override
  void didUpdateWidget(covariant PrivateMedicineImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.loader != widget.loader) {
      oldWidget.loader.removeListener(_changed);
      widget.loader.addListener(_changed);
    }
    if (oldWidget.loader != widget.loader ||
        oldWidget.medicineId != widget.medicineId ||
        oldWidget.photoId != widget.photoId ||
        oldWidget.width != widget.width ||
        oldWidget.height != widget.height) {
      final ratio = MediaQuery.devicePixelRatioOf(context);
      _decodeWidth = (widget.width * ratio).ceil();
      _decodeHeight = (widget.height * ratio).ceil();
      _start();
    }
  }

  void _start() {
    _displayedProvider?.evict();
    _displayedProvider = null;
    _request++;
    final photoId = widget.photoId;
    _future = photoId == null
        ? null
        : widget.loader.load(
            medicineId: widget.medicineId,
            photoId: photoId,
            width: _decodeWidth!,
            height: _decodeHeight!,
          );
  }

  void _changed() {
    if (mounted) setState(_start);
  }

  @override
  void dispose() {
    _displayedProvider?.evict();
    widget.loader.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
    width: widget.width,
    height: widget.height,
    child: FutureBuilder<Uint8List?>(
      key: ValueKey(_request),
      future: _future,
      builder: (context, snapshot) {
        final bytes = snapshot.connectionState == ConnectionState.done
            ? snapshot.data
            : null;
        if (bytes == null) {
          final failed =
              widget.photoId != null &&
              snapshot.connectionState == ConnectionState.done;
          return Material(
            color: const Color(0xFFE9F1EB),
            child: InkWell(
              onTap: failed ? () => setState(_start) : null,
              child: Center(
                child: Icon(
                  failed
                      ? Icons.broken_image_outlined
                      : Icons.medication_outlined,
                  color: const Color(0xFF62756B),
                  semanticLabel: failed ? '图片加载失败，点击重试' : '暂无图片',
                ),
              ),
            ),
          );
        }
        final provider = ResizeImage(MemoryImage(bytes), width: _decodeWidth);
        _displayedProvider = provider;
        return InkWell(
          onTap: widget.onTap,
          child: Image(
            image: provider,
            fit: widget.fit,
            width: widget.width,
            height: widget.height,
            errorBuilder: (context, error, stack) =>
                const Center(child: Icon(Icons.broken_image_outlined)),
          ),
        );
      },
    ),
  );
}
