import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:path_provider/path_provider.dart';

/// Opaque, nonsecret state. Callers must validate their own schema on every read.
abstract interface class PrivateAtomicState {
  Future<String?> read();
  Future<void> write(String value);
}

class MemoryPrivateAtomicState implements PrivateAtomicState {
  MemoryPrivateAtomicState({this.value});

  String? value;

  @override
  Future<String?> read() async => value;

  @override
  Future<void> write(String value) async => this.value = value;
}

/// Small app-private state committed by a same-directory rename.
///
/// A successful write survives ordinary process restart. This is not a promise
/// of power-loss durability: Dart does not expose a directory-fsync operation.
/// The application-support root is supplied by the platform, not by user data.
/// Platform-managed ancestor aliases are resolved once per operation; the root,
/// our child directory, and the state file themselves may not be links.
///
/// Operations are serialized within this isolate, including separate instances
/// for the same file. This is not a multi-process lock or protection against a
/// hostile actor concurrently replacing the app's private filesystem paths.
/// Incomplete temporary files are never promoted, read, or swept. A failed write
/// may leave its own bounded temporary file; only the exact committed name is
/// authoritative. No credentials or medication payloads belong in this store.
class FilePrivateAtomicState implements PrivateAtomicState {
  FilePrivateAtomicState({
    Future<Directory> Function()? directoryProvider,
    String name = 'session-identity.v1.json',
  }) : _directoryProvider = directoryProvider ?? getApplicationSupportDirectory,
       _name = _validateName(name);

  static const maxBytes = 64 * 1024;
  static const _directoryName = 'medicine-private-state';
  static final _random = Random.secure();
  static final Map<String, Future<void>> _pathTails = {};

  final Future<Directory> Function() _directoryProvider;
  final String _name;
  Future<void> _tail = Future<void>.value();

  static String _validateName(String name) {
    if (name.length > 96 ||
        !RegExp(r'^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$').hasMatch(name) ||
        RegExp(
          r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)',
          caseSensitive: false,
        ).hasMatch(name)) {
      throw ArgumentError.value(name, 'name', 'Expected a safe file name.');
    }
    return name;
  }

  Future<T> _serialize<T>(Future<T> Function() action) {
    final next = _tail.then((_) => action());
    _tail = next.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return next;
  }

  Future<T> _atPath<T>(String path, Future<T> Function() action) async {
    final previous = _pathTails[path] ?? Future<void>.value();
    final next = previous.then((_) => action());
    final settled = next.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    _pathTails[path] = settled;
    try {
      return await next;
    } finally {
      if (identical(_pathTails[path], settled)) _pathTails.remove(path);
    }
  }

  static Future<FileSystemEntityType> _type(String path) =>
      FileSystemEntity.type(path, followLinks: false);

  static Future<void> _requireDirectory(Directory directory) async {
    if (await _type(directory.path) != FileSystemEntityType.directory) {
      throw FileSystemException(
        'State directory is missing or unsafe.',
        directory.path,
      );
    }
  }

  Future<Directory> _supportDirectory() async {
    final directory = await _directoryProvider();
    final path = directory.path;
    if (!directory.isAbsolute ||
        path.contains(RegExp(r'[\x00-\x1f]')) ||
        path
            .split(RegExp(r'[/\\]'))
            .any((part) => part == '.' || part == '..')) {
      throw FileSystemException('Unsafe application-support path.', path);
    }
    // The platform provider owns creation of its root. Never recursively create
    // an arbitrary provider path, and never fall back to shared/temp storage.
    await _requireDirectory(directory);
    final canonical = Directory(await directory.resolveSymbolicLinks());
    await _requireDirectory(directory);
    await _requireDirectory(canonical);
    return canonical;
  }

  static Future<void> _requireFileOrMissing(File file) async {
    final type = await _type(file.path);
    if (type != FileSystemEntityType.file &&
        type != FileSystemEntityType.notFound) {
      throw FileSystemException('State path is not a regular file.', file.path);
    }
  }

  @override
  Future<String?> read() => _serialize(() async {
    final support = await _supportDirectory();
    final directory = Directory('${support.path}/$_directoryName');
    final file = File('${directory.path}/$_name');
    return _atPath(file.path, () async {
      await _requireDirectory(support);
      final directoryType = await _type(directory.path);
      if (directoryType == FileSystemEntityType.notFound) return null;
      await _requireDirectory(directory);
      await _requireFileOrMissing(file);
      if (await _type(file.path) == FileSystemEntityType.notFound) return null;
      final handle = await file.open(mode: FileMode.read);
      try {
        // Bound both allocation and IO even if an unexpected writer grows it.
        if (await handle.length() > maxBytes) {
          throw FileSystemException('State exceeds its size limit.', file.path);
        }
        final bytes = <int>[];
        while (bytes.length <= maxBytes) {
          final chunk = await handle.read(maxBytes + 1 - bytes.length);
          if (chunk.isEmpty) break;
          bytes.addAll(chunk);
        }
        if (bytes.length > maxBytes) {
          throw FileSystemException('State exceeds its size limit.', file.path);
        }
        await _requireDirectory(support);
        await _requireDirectory(directory);
        await _requireFileOrMissing(file);
        // Empty and malformed JSON remain visible to the schema owner, never
        // confused with absent state. Malformed UTF-8 throws rather than repairs.
        return utf8.decode(bytes, allowMalformed: false);
      } finally {
        await handle.close();
      }
    });
  });

  @override
  Future<void> write(String value) => _serialize(() async {
    if (value.length > maxBytes) {
      throw ArgumentError.value(value.length, 'value', 'State is too large.');
    }
    final bytes = utf8.encode(value);
    if (bytes.length > maxBytes || utf8.decode(bytes) != value) {
      throw ArgumentError('State must be valid UTF-8 within $maxBytes bytes.');
    }
    final support = await _supportDirectory();
    final directory = Directory('${support.path}/$_directoryName');
    final file = File('${directory.path}/$_name');
    await _atPath(file.path, () async {
      await _requireDirectory(support);
      if (await _type(directory.path) == FileSystemEntityType.notFound) {
        await directory.create(); // Exact child only; never recursive.
      }
      await _requireDirectory(directory);
      await _requireFileOrMissing(file);
      final nonce = List.generate(
        16,
        (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
      ).join();
      final temporary = File('${directory.path}/.$_name.$nonce.tmp');
      // Exclusive creation prevents overwriting any pre-existing sibling. A
      // collision fails the write; it never changes an existing entity.
      await temporary.create(exclusive: true);
      await _requireDirectory(support);
      await _requireDirectory(directory);
      if (await _type(temporary.path) != FileSystemEntityType.file) {
        throw FileSystemException(
          'Temporary state path is unsafe.',
          temporary.path,
        );
      }
      final handle = await temporary.open(mode: FileMode.writeOnly);
      try {
        await handle.writeFrom(bytes);
        await handle.flush();
      } finally {
        await handle.close();
      }
      await _requireDirectory(support);
      await _requireDirectory(directory);
      if (await _type(temporary.path) != FileSystemEntityType.file) {
        throw FileSystemException(
          'Temporary state path is unsafe.',
          temporary.path,
        );
      }
      await _requireFileOrMissing(file);
      // No delete-first or copy fallback: failure preserves the old commit.
      await temporary.rename(file.path);
    });
  });
}
