import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:path_provider/path_provider.dart';

import 'export_ownership_journal.dart';

class ExportTemporaryException implements Exception {
  const ExportTemporaryException(this.message);
  final String message;
  @override
  String toString() => message;
}

enum ExportRecoveryIssueKind {
  ambiguousOwnership,
  cleanupFailed,
  journalUnavailable,
  rootUnavailable,
}

class ExportRecoveryIssue {
  const ExportRecoveryIssue(this.kind, {this.entryId});
  final ExportRecoveryIssueKind kind;
  // Generated nonsecret ID only; never a path or payload.
  final String? entryId;
}

class ExportRecoveryException extends ExportTemporaryException {
  ExportRecoveryException(List<ExportRecoveryIssue> issues)
    : issues = List.unmodifiable(issues),
      super(_message(issues));
  final List<ExportRecoveryIssue> issues;
  static String _message(List<ExportRecoveryIssue> issues) {
    if (issues.any(
      (issue) => issue.kind == ExportRecoveryIssueKind.ambiguousOwnership,
    )) {
      return '旧导出文件的所有权无法确认，已保留文件并暂停新导出。登录和其他功能可继续使用；问题解决后可重试清理。';
    }
    if (issues.any(
      (issue) => issue.kind == ExportRecoveryIssueKind.journalUnavailable,
    )) {
      return '导出清理记录无法读取，已暂停新导出。登录和其他功能可继续使用；本机存储恢复后可重试。';
    }
    if (issues.any(
      (issue) => issue.kind == ExportRecoveryIssueKind.rootUnavailable,
    )) {
      return '导出临时目录不可用，已暂停新导出。登录和其他功能可继续使用；本机存储恢复后可重试。';
    }
    return '旧导出文件清理未完成，已保留清理记录。登录和其他功能可继续使用；请检查本机存储后重试。';
  }
}

class _AmbiguousExportOwnership extends ExportTemporaryException {
  const _AmbiguousExportOwnership(super.message);
}

/// One coordinator per running app isolate. Recreating a service/store does not
/// simulate process death or release another store's write/native handoff lease.
/// A separate coordinator is only for a separately isolated synthetic process.
class ExportProcessCoordinator {
  ExportProcessCoordinator({
    Future<Directory> Function()? temporaryDirectory,
    ExportOwnershipJournal? journal,
    Future<void> Function(File)? deleteFile,
  }) : _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory,
       _journal = journal ?? ExportOwnershipJournal(),
       _deleteFile = deleteFile ?? _delete;

  static final application = ExportProcessCoordinator();
  static final _random = Random.secure();
  static String _nonce() => List.generate(
    16,
    (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
  static Future<void> _delete(File file) => file.delete();
  static Future<FileSystemEntityType> _type(String path) =>
      FileSystemEntity.type(path, followLinks: false);

  final String _process = _nonce();
  final Future<Directory> Function() _temporaryDirectory;
  final ExportOwnershipJournal _journal;
  final Future<void> Function(File) _deleteFile;
  final Set<OwnedExportFile> _files = {};
  OwnedExportFile? _activeHandoff;
  Directory? _root;
  Future<void>? _initializing;
  Future<void>? _startupRecovery;
  bool _initialized = false;
  List<ExportRecoveryIssue> _recoveryIssues = const [];
  List<ExportRecoveryIssue> get recoveryIssues => _recoveryIssues;
  int _identityEpoch = 0;
  int get identityEpoch => _identityEpoch;

  /// Complete recovery before preparing another export. Failed recovery remains
  /// retryable and never overwrites unreadable/corrupt ownership metadata.
  Future<void> initialize() {
    if (_initialized) return Future.value();
    return _initializing ??= _initialize().whenComplete(
      () => _initializing = null,
    );
  }

  /// Start once without leaking an unhandled background error into login or
  /// unrelated work. Completion means the attempt settled, not cleanup success;
  /// callers inspect recoveryIssues. Explicit initialize/create can retry.
  Future<void> recoverForStartup() =>
      _startupRecovery ??= initialize().then<void>(
        (_) {},
        onError: (Object error, StackTrace _) {
          _recoveryIssues = error is ExportRecoveryException
              ? error.issues
              : const [
                  ExportRecoveryIssue(ExportRecoveryIssueKind.cleanupFailed),
                ];
        },
      );

  Future<void> _initialize() async {
    try {
      _root ??= await _trustedRoot();
    } catch (_) {
      _recoveryIssues = const [
        ExportRecoveryIssue(ExportRecoveryIssueKind.rootUnavailable),
      ];
      throw ExportRecoveryException(_recoveryIssues);
    }
    final List<ExportOwnershipRecord> records;
    try {
      records = await _journal.read();
    } catch (_) {
      _recoveryIssues = const [
        ExportRecoveryIssue(ExportRecoveryIssueKind.journalUnavailable),
      ];
      throw ExportRecoveryException(_recoveryIssues);
    }
    final issues = <ExportRecoveryIssue>[];
    for (final record in records) {
      if (_files.any((file) => file._record.id == record.id)) continue;
      try {
        // A persisted sharing flag cannot pin an old-process lease forever.
        // Only this coordinator's live write/handoff objects are protected.
        await _clean(record);
        await _journal.unregister(record);
      } catch (error) {
        issues.add(
          ExportRecoveryIssue(
            error is _AmbiguousExportOwnership
                ? ExportRecoveryIssueKind.ambiguousOwnership
                : ExportRecoveryIssueKind.cleanupFailed,
            entryId: record.id,
          ),
        );
      }
    }
    _recoveryIssues = List.unmodifiable(issues);
    if (issues.isNotEmpty) throw ExportRecoveryException(issues);
    _initialized = true;
  }

  Future<Directory> _trustedRoot() async {
    final provided = await _temporaryDirectory();
    if (!provided.isAbsolute ||
        provided.path.contains(RegExp(r'[\x00-\x1f]')) ||
        provided.path
            .split(RegExp(r'[/\\]'))
            .any((part) => part == '.' || part == '..') ||
        await _type(provided.path) != FileSystemEntityType.directory) {
      throw const ExportTemporaryException('临时目录不可用，无法安全导出。');
    }
    // Platform-managed ancestor aliases may resolve; the root itself cannot be
    // a link. Journal paths never choose a root or contain an absolute path.
    final root = Directory(await provided.resolveSymbolicLinks());
    if (await _type(provided.path) != FileSystemEntityType.directory ||
        await _type(root.path) != FileSystemEntityType.directory) {
      throw const ExportTemporaryException('临时目录已变化，无法安全导出。');
    }
    return root;
  }

  Future<void> _checkRoot() async {
    if (_root == null ||
        await _type(_root!.path) != FileSystemEntityType.directory ||
        await _root!.resolveSymbolicLinks() != _root!.path) {
      throw const _AmbiguousExportOwnership('临时目录已变化，无法安全清理。');
    }
  }

  Future<void> _verifyMarker(
    ExportOwnershipRecord record,
    Directory directory,
  ) async {
    await _checkRoot();
    if (await _type(directory.path) != FileSystemEntityType.directory) {
      throw const _AmbiguousExportOwnership('临时文件目录已变化，无法安全清理。');
    }
    final marker = File('${directory.path}/${record.marker}');
    if (await _type(marker.path) != FileSystemEntityType.file ||
        !record.markerStamp.matches(await marker.stat()) ||
        await marker.length() != record.id.length ||
        await marker.readAsString() != record.id) {
      throw const _AmbiguousExportOwnership('临时文件所有权凭据已变化，无法安全清理。');
    }
  }

  Future<String> _digest(File file, ExportFileStamp stamp) async {
    if (await _type(file.path) != FileSystemEntityType.file ||
        !stamp.matches(await file.stat())) {
      throw const _AmbiguousExportOwnership('临时文件已变化，无法验证内容。');
    }
    // Stream at most the registered size plus one byte. No content enters logs
    // or the journal; the digest supplements stat evidence, not inode identity.
    final digest = await sha256.bind(file.openRead(0, stamp.size + 1)).first;
    if (await _type(file.path) != FileSystemEntityType.file ||
        !stamp.matches(await file.stat())) {
      throw const _AmbiguousExportOwnership('验证期间临时文件已变化。');
    }
    return digest.toString();
  }

  Future<bool> _matchesOriginal(ExportOwnershipRecord record, File file) async {
    final ready = record.readyStamp;
    if (ready != null) {
      return record.readySha256 == await _digest(file, ready);
    }
    // Portable dart:io cannot establish ownership of a changed uncommitted
    // regular file after a crash. Only its unchanged empty original is safe.
    return record.initialStamp.matches(await file.stat());
  }

  Future<void> _clean(ExportOwnershipRecord record) async {
    await _checkRoot();
    final directory = Directory('${_root!.path}/${record.directory}');
    final directoryType = await _type(directory.path);
    if (directoryType == FileSystemEntityType.notFound) return;
    if (directoryType != FileSystemEntityType.directory) {
      throw const _AmbiguousExportOwnership('临时文件目录已变化，无法安全清理。');
    }
    final file = File('${directory.path}/${record.name}');
    final fileType = await _type(file.path);
    final marker = File('${directory.path}/${record.marker}');
    if (fileType == FileSystemEntityType.notFound &&
        await _type(marker.path) == FileSystemEntityType.notFound) {
      // Cleanup may have finished before an unregister failed. Leave an
      // unproven empty directory and unexpected siblings untouched.
      return;
    }
    await _verifyMarker(record, directory);
    if (fileType != FileSystemEntityType.notFound) {
      if (fileType != FileSystemEntityType.file ||
          !await _matchesOriginal(record, file)) {
        throw const _AmbiguousExportOwnership('临时文件路径或内容证据已变化，无法安全清理。');
      }
      await _deleteFile(file);
    }
    // Keep the journal record until both exact owned paths are gone. Failed
    // unregister is safe to retry with the paths already missing.
    await _verifyMarker(record, directory);
    await _deleteFile(marker);
    if (await directory.list(followLinks: false).isEmpty) {
      await directory.delete(); // Never recursive; preserves all extra files.
    }
  }

  void _ensureIdentity(int epoch) {
    if (epoch != _identityEpoch) {
      throw const ExportTemporaryException('会话已变更，请重新进入导出页面。');
    }
  }

  Future<void> resetForIdentity() {
    _identityEpoch++;
    // Increment before fallible initialization, waiting writes, or filesystem IO.
    return Future.wait(_files.toList().map(release));
  }

  Future<void> release(OwnedExportFile owned) {
    if (!_files.contains(owned) || owned._released || owned._handingOff) {
      return Future.value();
    }
    return owned._cleanup ??= _release(owned)
        .onError((Object error, StackTrace stack) {
          owned._cleanupError = error;
          if (error is ExportTemporaryException) {
            Error.throwWithStackTrace(error, stack);
          }
          throw const ExportTemporaryException('临时导出文件未能清理，请检查本机存储后重试。');
        })
        .whenComplete(() => owned._cleanup = null);
  }

  Future<void> _release(OwnedExportFile owned) async {
    await owned._writeDone.future;
    await _clean(owned._record);
    await _journal.unregister(owned._record);
    owned._released = true;
    owned._cleanupError = null;
    _files.remove(owned);
  }
}

/// Public store API is preserved; all process-wide ownership and native leases
/// belong to the coordinator rather than a particular service/store instance.
class ExportTemporaryStore {
  ExportTemporaryStore({
    Future<void> Function(File, List<int>)? writeBytes,
    ExportProcessCoordinator? process,
  }) : _process = process ?? ExportProcessCoordinator.application,
       _writeBytes = writeBytes ?? _writeFile;

  final ExportProcessCoordinator _process;
  final Future<void> Function(File, List<int>) _writeBytes;
  int get identityEpoch => _process.identityEpoch;
  Future<void> initialize() => _process.initialize();
  Future<void> recoverForStartup() => _process.recoverForStartup();
  List<ExportRecoveryIssue> get recoveryIssues => _process.recoveryIssues;
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
      _process._ensureIdentity(identityEpoch);
      if (isCurrent != null && !isCurrent()) {
        throw const ExportTemporaryException('会话或页面已变更，请重新导出。');
      }
    }

    ensureCurrent();
    await initialize();
    ensureCurrent();
    await _process._checkRoot();
    final id = ExportProcessCoordinator._nonce();
    final directory = await _process._root!.createTemp(
      'medicine-export-owned-$id-',
    );
    final nonce = ExportProcessCoordinator._nonce();
    final name =
        '${backup ? 'medicine-cabinet-backup' : 'medicine-inventory'}-$nonce.$extension';
    final file = File('${directory.path}/$name');
    final marker = File('${directory.path}/ownership-$id.v1');
    // Everything before registration is empty or nonsecret. Never use a
    // fallback write if allocation, marker setup or registration fails.
    await file.create(exclusive: true);
    await marker.create(exclusive: true);
    await marker.writeAsString(id, flush: true);
    final record = ExportOwnershipRecord(
      id: id,
      process: _process._process,
      directory: directory.path.substring(_process._root!.path.length + 1),
      name: name,
      markerStamp: ExportFileStamp.fromStat(await marker.stat()),
      initialStamp: ExportFileStamp.fromStat(await file.stat()),
    );
    final owned = OwnedExportFile._(_process, file, record, identityEpoch);
    _process._files.add(owned);
    Object? failure;
    StackTrace? failureStack;
    var startedWriting = false;
    FileStat? writeDirectoryStamp;
    Future<bool> unchangedWriteDirectory() async {
      final before = writeDirectoryStamp;
      if (before == null ||
          await ExportProcessCoordinator._type(directory.path) !=
              FileSystemEntityType.directory) {
        return false;
      }
      final now = await directory.stat();
      return now.type == FileSystemEntityType.directory &&
          before.modified == now.modified &&
          before.changed == now.changed;
    }

    try {
      await _process._journal.register(record);
      ensureCurrent();
      await _process._verifyMarker(record, directory);
      if (await ExportProcessCoordinator._type(file.path) !=
              FileSystemEntityType.file ||
          !record.initialStamp.matches(await file.stat())) {
        throw const ExportTemporaryException('临时文件已变化，无法安全写入。');
      }
      ensureCurrent();
      writeDirectoryStamp = await directory.stat();
      ensureCurrent();
      startedWriting = true;
      final payload = List<int>.unmodifiable(bytes);
      await _writeBytes(file, payload);
      if (!await unchangedWriteDirectory()) {
        throw const _AmbiguousExportOwnership('写入期间临时目录已变化，无法确认所有权。');
      }
      await _process._verifyMarker(record, directory);
      if (await ExportProcessCoordinator._type(file.path) !=
          FileSystemEntityType.file) {
        throw const ExportTemporaryException('临时文件已变化，无法确认所有权。');
      }
      final stamp = ExportFileStamp.fromStat(await file.stat());
      final digest = await _process._digest(file, stamp);
      if (!await unchangedWriteDirectory()) {
        throw const _AmbiguousExportOwnership('验证期间临时目录已变化。');
      }
      owned._record = record.ready(stamp, digest);
      if (digest != sha256.convert(payload).toString()) {
        throw const ExportTemporaryException('导出文件写入不完整，请重试。');
      }
      await _process._journal.markReady(owned._record);
      ensureCurrent();
    } catch (error, stack) {
      failure = error;
      failureStack = stack;
      if (startedWriting && owned._record.readyStamp == null) {
        // The writer settled in this live process. Its exact registered regular
        // path can be cleaned; this inference is never made after process death.
        try {
          if (!await unchangedWriteDirectory()) {
            throw const _AmbiguousExportOwnership('写入期间临时目录已变化。');
          }
          await _process._verifyMarker(record, directory);
          if (await ExportProcessCoordinator._type(file.path) ==
              FileSystemEntityType.file) {
            final stamp = ExportFileStamp.fromStat(await file.stat());
            final digest = await _process._digest(file, stamp);
            if (await unchangedWriteDirectory()) {
              owned._record = record.ready(stamp, digest);
            }
          }
        } catch (_) {
          /* Unsafe paths stay registered and are reported. */
        }
      }
    } finally {
      owned._writeDone.complete();
    }
    if (failure != null) {
      try {
        await release(owned);
      } catch (_) {
        /* Ownership retained for retry. */
      }
      Error.throwWithStackTrace(failure, failureStack!);
    }
    return owned;
  }

  Future<T> handoff<T>(
    OwnedExportFile owned, {
    required bool Function() isCurrent,
    required Future<T> Function(File file) send,
  }) async {
    void ensureCurrent() {
      if (!_process._files.contains(owned) ||
          owned._released ||
          owned._cleanup != null) {
        throw const ExportTemporaryException('导出文件已失效，请重新生成。');
      }
      _process._ensureIdentity(owned._identityEpoch);
      if (!isCurrent()) throw const ExportTemporaryException('会话或页面已变更，请重新导出。');
      if (_process._activeHandoff != null) {
        throw const ExportTemporaryException('请先完成或关闭当前分享窗口，再次分享。');
      }
    }

    ensureCurrent();
    await initialize();
    await _process._verifyMarker(owned._record, owned.file.parent);
    if (owned._record.readyStamp == null ||
        await ExportProcessCoordinator._type(owned.file.path) !=
            FileSystemEntityType.file ||
        !await _process._matchesOriginal(owned._record, owned.file)) {
      throw const _AmbiguousExportOwnership('导出文件已变化，无法安全分享。');
    }
    // Preflight can yield; repeat every dispatch/lease guard afterwards.
    ensureCurrent();
    // No await between the final guards and native dispatch.
    _process._activeHandoff = owned;
    owned._handingOff = true;
    try {
      return await send(owned.file);
    } finally {
      owned._handingOff = false;
      _process._activeHandoff = null;
      try {
        await release(owned);
      } catch (error) {
        owned._cleanupError = error;
      }
    }
  }

  Future<void> resetForIdentity() => _process.resetForIdentity();
  Future<void> release(OwnedExportFile owned) => _process.release(owned);
}

class OwnedExportFile {
  OwnedExportFile._(this._owner, this.file, this._record, this._identityEpoch);
  final ExportProcessCoordinator _owner;
  final File file;
  ExportOwnershipRecord _record;
  final int _identityEpoch;
  final Completer<void> _writeDone = Completer<void>.sync();
  bool _handingOff = false;
  bool _released = false;
  Future<void>? _cleanup;
  Object? _cleanupError;
  Object? get cleanupError => _cleanupError;
  Future<void> release() => _owner.release(this);
}
