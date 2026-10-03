import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:path_provider/path_provider.dart';

class ExportTemporaryException implements Exception {
  const ExportTemporaryException(this.message);
  final String message;
}

/// Owns only files created by this instance in uniquely allocated directories.
/// Never sweeps the shared temp root, share_plus cache, or recipient copies.
class ExportTemporaryStore {
  ExportTemporaryStore({
    Future<Directory> Function()? temporaryDirectory,
    Future<void> Function(File, List<int>)? writeBytes,
  }) : _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory,
       _writeBytes = writeBytes ?? _writeFile;

  static final _random = Random.secure();
  final Future<Directory> Function() _temporaryDirectory;
  final Future<void> Function(File, List<int>) _writeBytes;
  final Set<OwnedExportFile> _files = {};
  OwnedExportFile? _activeHandoff;
  int _identityEpoch = 0;
  int get identityEpoch => _identityEpoch;

  static Future<void> _writeFile(File file, List<int> bytes) async {
    await file.writeAsBytes(bytes, flush: true);
  }

  Future<OwnedExportFile> create({
    required List<int> bytes,
    required String extension,
    required int identityEpoch,
    bool backup = false,
    bool Function()? isCurrent,
  }) async {
    if (!const {'md', 'csv', 'pdf', 'json'}.contains(extension) ||
        (backup && extension != 'json')) {
      throw ArgumentError.value(extension, 'extension');
    }
    void ensureCurrent() {
      _ensureIdentity(identityEpoch);
      if (isCurrent != null && !isCurrent()) {
        throw const ExportTemporaryException('会话或页面已变更，请重新导出。');
      }
    }

    ensureCurrent();
    final root = await _temporaryDirectory();
    ensureCurrent();
    // Random, exclusively allocated directory; no server-provided identifiers.
    final directory = await root.createTemp('medicine-export-owned-');
    final nonce = List.generate(
      16,
      (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    final file = File(
      '${directory.path}/${backup ? 'medicine-cabinet-backup' : 'medicine-inventory'}-$nonce.$extension',
    );
    final owned = OwnedExportFile._(this, directory, file, identityEpoch);
    _files.add(owned);
    Object? failure;
    StackTrace? failureStack;
    try {
      ensureCurrent();
      await _writeBytes(file, List<int>.unmodifiable(bytes));
    } catch (error, stack) {
      failure = error;
      failureStack = stack;
    } finally {
      owned._writeDone.complete();
    }
    if (failure != null || identityEpoch != _identityEpoch) {
      await release(owned);
      if (failure != null) Error.throwWithStackTrace(failure, failureStack!);
      _ensureIdentity(identityEpoch);
    }
    return owned;
  }

  void _ensureIdentity(int epoch) {
    if (epoch != _identityEpoch) {
      throw const ExportTemporaryException('会话已变更，请重新进入导出页面。');
    }
  }

  /// Lease the original until the platform Future settles. On locked Android
  /// share_plus 13.3.0, native code copies it before launching the share target.
  /// A successful result means selection, not delivery or recipient completion.
  Future<T> handoff<T>(
    OwnedExportFile owned, {
    required bool Function() isCurrent,
    required Future<T> Function(File file) send,
  }) async {
    if (!_files.contains(owned) || owned._released || owned._cleanup != null) {
      throw const ExportTemporaryException('导出文件已失效，请重新生成。');
    }
    _ensureIdentity(owned._identityEpoch);
    if (!isCurrent()) {
      throw const ExportTemporaryException('会话或页面已变更，请重新导出。');
    }
    if (_activeHandoff != null) {
      throw const ExportTemporaryException('请先完成或关闭当前分享窗口，再次分享。');
    }
    // No await between the final guard and dispatch.
    _activeHandoff = owned;
    owned._handingOff = true;
    try {
      return await send(owned.file);
    } finally {
      owned._handingOff = false;
      _activeHandoff = null;
      try {
        await release(owned);
      } catch (error) {
        // Preserve the native outcome. Caller may retry release/report cleanup
        // separately; ownership is retained for the next identity cleanup.
        owned._cleanupError = error;
      }
    }
  }

  /// Invalidate immediately, then drain writes and delete idle originals.
  /// An already-dispatched native handoff cannot be recalled; its lease cleans
  /// itself up when the platform returns without holding logout open.
  Future<void> resetForIdentity() {
    _identityEpoch++;
    return Future.wait(_files.toList().map(release));
  }

  Future<void> release(OwnedExportFile owned) {
    if (!_files.contains(owned) || owned._released || owned._handingOff) {
      return Future.value();
    }
    return owned._cleanup ??= _deleteOwned(owned)
        .onError((Object error, StackTrace stack) {
          if (error is ExportTemporaryException) {
            Error.throwWithStackTrace(error, stack);
          }
          throw const ExportTemporaryException('临时导出文件未能清理，请重新连接药箱后再试。');
        })
        .whenComplete(() {
          owned._cleanup = null;
        });
  }

  Future<void> _deleteOwned(OwnedExportFile owned) async {
    await owned._writeDone.future;
    // Exact registered paths only. Do not follow a substituted directory/link,
    // recurse into a directory, or remove any extra files someone else owns.
    final directoryType = await FileSystemEntity.type(
      owned._directory.path,
      followLinks: false,
    );
    if (directoryType == FileSystemEntityType.notFound) {
      owned._released = true;
      _files.remove(owned);
      return;
    }
    if (directoryType != FileSystemEntityType.directory) {
      throw const ExportTemporaryException('临时文件目录已变化，无法安全清理。');
    }
    final type = await FileSystemEntity.type(
      owned.file.path,
      followLinks: false,
    );
    if (type == FileSystemEntityType.file ||
        type == FileSystemEntityType.link) {
      await owned.file.delete(); // Deleting a link removes only that link.
    } else if (type != FileSystemEntityType.notFound) {
      throw const ExportTemporaryException('临时文件路径已变化，无法安全清理。');
    }
    // Non-recursive deletion preserves any unexpected/user-owned extra files.
    if (await owned._directory.list(followLinks: false).isEmpty) {
      await owned._directory.delete();
    }
    owned._released = true;
    owned._cleanupError = null;
    _files.remove(owned);
  }
}

class OwnedExportFile {
  OwnedExportFile._(
    this._owner,
    this._directory,
    this.file,
    this._identityEpoch,
  );
  final ExportTemporaryStore _owner;
  final Directory _directory;
  final File file;
  final int _identityEpoch;
  final Completer<void> _writeDone = Completer<void>.sync();
  bool _handingOff = false;
  bool _released = false;
  Future<void>? _cleanup;
  Object? _cleanupError;
  Object? get cleanupError => _cleanupError;

  Future<void> release() => _owner.release(this);
}
