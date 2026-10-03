import 'dart:convert';
import 'dart:io';

import 'private_atomic_state.dart';

/// Only generated components and nonsecret filesystem ownership evidence.
/// Never stores export bytes, user/family IDs, credentials, or absolute paths.
class ExportOwnershipRecord {
  const ExportOwnershipRecord({
    required this.id,
    required this.process,
    required this.directory,
    required this.name,
    required this.markerStamp,
    required this.initialStamp,
    this.readyStamp,
    this.readySha256,
  });

  final String id;
  final String process;
  final String directory;
  final String name;
  final ExportFileStamp markerStamp;
  final ExportFileStamp initialStamp;
  final ExportFileStamp? readyStamp;
  final String? readySha256;
  String get marker => 'ownership-$id.v1';

  ExportOwnershipRecord ready(ExportFileStamp stamp, String sha256) =>
      ExportOwnershipRecord(
        id: id,
        process: process,
        directory: directory,
        name: name,
        markerStamp: markerStamp,
        initialStamp: initialStamp,
        readyStamp: stamp,
        readySha256: sha256,
      );

  Map<String, Object?> toJson() => {
    'id': id,
    'process': process,
    'directory': directory,
    'name': name,
    'markerStamp': markerStamp.toJson(),
    'initialStamp': initialStamp.toJson(),
    'readyStamp': readyStamp?.toJson(),
    'readySha256': readySha256,
  };

  static final _nonce = RegExp(r'^[0-9a-f]{32}$');
  static ExportOwnershipRecord parse(Object? value) {
    final map = _object(value, const {
      'id',
      'process',
      'directory',
      'name',
      'markerStamp',
      'initialStamp',
      'readyStamp',
      'readySha256',
    });
    final id = map['id'];
    final process = map['process'];
    final directory = map['directory'];
    final name = map['name'];
    if (id is! String ||
        id.length != 32 ||
        !_nonce.hasMatch(id) ||
        process is! String ||
        process.length != 32 ||
        !_nonce.hasMatch(process) ||
        directory is! String ||
        !RegExp('^medicine-export-owned-$id-[A-Za-z0-9_-]{1,32}\$')
            .hasMatch(directory) ||
        name is! String ||
        !RegExp(
          r'^(medicine-inventory-[0-9a-f]{32}\.(md|csv|pdf|json)|medicine-cabinet-backup-[0-9a-f]{32}\.json)$',
        ).hasMatch(name)) {
      throw const FormatException('Invalid export ownership components.');
    }
    final readyDigest = map['readySha256'];
    if ((map['readyStamp'] == null) != (readyDigest == null) ||
        (readyDigest != null &&
            (readyDigest is! String ||
                readyDigest.length != 64 ||
                !RegExp(r'^[0-9a-f]{64}$').hasMatch(readyDigest)))) {
      throw const FormatException('Invalid completed export digest.');
    }
    final markerStamp = ExportFileStamp.parse(map['markerStamp']);
    final initialStamp = ExportFileStamp.parse(map['initialStamp']);
    if (markerStamp.size != 32 || initialStamp.size != 0) {
      throw const FormatException('Invalid allocated export evidence.');
    }
    return ExportOwnershipRecord(
      id: id,
      process: process,
      directory: directory,
      name: name,
      markerStamp: markerStamp,
      initialStamp: initialStamp,
      readySha256: readyDigest as String?,
      readyStamp: map['readyStamp'] == null
          ? null
          : ExportFileStamp.parse(map['readyStamp']),
    );
  }
}

/// Conservative portable evidence, not an inode identity or cryptographic proof.
class ExportFileStamp {
  const ExportFileStamp(this.modified, this.changed, this.size, this.mode);
  factory ExportFileStamp.fromStat(FileStat stat) {
    if (stat.type != FileSystemEntityType.file) {
      throw const FileSystemException('Expected a regular owned file.');
    }
    return ExportFileStamp(
      stat.modified.microsecondsSinceEpoch,
      stat.changed.microsecondsSinceEpoch,
      stat.size,
      stat.mode,
    );
  }
  final int modified;
  final int changed;
  final int size;
  final int mode;
  bool matches(FileStat stat) =>
      stat.type == FileSystemEntityType.file &&
      modified == stat.modified.microsecondsSinceEpoch &&
      changed == stat.changed.microsecondsSinceEpoch &&
      size == stat.size &&
      mode == stat.mode;
  Map<String, int> toJson() => {
    'modified': modified,
    'changed': changed,
    'size': size,
    'mode': mode,
  };
  static ExportFileStamp parse(Object? value) {
    final map = _object(value, const {'modified', 'changed', 'size', 'mode'});
    for (final key in map.keys) {
      final number = map[key];
      if (number is! int || number < 0 || number > 9007199254740991) {
        throw const FormatException('Invalid export ownership evidence.');
      }
    }
    if ((map['mode'] as int) > 0xffff) {
      throw const FormatException('Invalid export mode.');
    }
    return ExportFileStamp(
      map['modified'] as int,
      map['changed'] as int,
      map['size'] as int,
      map['mode'] as int,
    );
  }
}

Map<String, dynamic> _object(Object? value, Set<String> keys) {
  if (value is! Map<String, dynamic> ||
      value.length != keys.length ||
      !keys.every(value.containsKey)) {
    throw const FormatException('Malformed export ownership metadata.');
  }
  return value;
}

class ExportOwnershipJournal {
  ExportOwnershipJournal({PrivateAtomicState? state})
    : _state =
          state ?? FilePrivateAtomicState(name: 'export-ownership.v1.json');
  static const maxEntries = 64;
  final PrivateAtomicState _state;
  Future<void> _tail = Future.value();

  Future<T> _serial<T>(Future<T> Function() action) {
    final next = _tail.then((_) => action());
    _tail = next.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return next;
  }

  Future<Map<String, ExportOwnershipRecord>> _read() async {
    final raw = await _state.read();
    if (raw == null) return {};
    if (raw.length > FilePrivateAtomicState.maxBytes ||
        utf8.encode(raw).length > FilePrivateAtomicState.maxBytes) {
      throw const FormatException('Export ownership metadata is too large.');
    }
    final decoded = jsonDecode(raw);
    // Only our compact canonical representation is accepted. In particular,
    // duplicate JSON keys must not silently replace ownership evidence.
    if (jsonEncode(decoded) != raw) {
      throw const FormatException('Ambiguous export ownership JSON.');
    }
    final map = _object(decoded, const {'version', 'entries'});
    if (map['version'] is! int ||
        map['version'] != 1 ||
        map['entries'] is! List ||
        (map['entries'] as List).length > maxEntries) {
      throw const FormatException('Unsupported export ownership metadata.');
    }
    final records = <String, ExportOwnershipRecord>{};
    final directories = <String>{};
    for (final value in map['entries'] as List) {
      final record = ExportOwnershipRecord.parse(value);
      if (records.containsKey(record.id) ||
          !directories.add(record.directory)) {
        throw const FormatException('Ambiguous export ownership metadata.');
      }
      records[record.id] = record;
    }
    return records;
  }

  Future<List<ExportOwnershipRecord>> read() =>
      _serial(() async => (await _read()).values.toList());

  Future<void> register(ExportOwnershipRecord record) => _serial(() async {
    final records = await _read();
    if (records.length >= maxEntries ||
        records.containsKey(record.id) ||
        records.values.any((value) => value.directory == record.directory)) {
      throw const FormatException(
        'Export ownership journal is full or ambiguous.',
      );
    }
    records[record.id] = ExportOwnershipRecord.parse(record.toJson());
    await _write(records);
  });

  bool _sameOwner(ExportOwnershipRecord a, ExportOwnershipRecord b) =>
      a.id == b.id &&
      a.process == b.process &&
      a.directory == b.directory &&
      a.name == b.name &&
      jsonEncode(a.markerStamp.toJson()) ==
          jsonEncode(b.markerStamp.toJson()) &&
      jsonEncode(a.initialStamp.toJson()) ==
          jsonEncode(b.initialStamp.toJson());

  Future<void> markReady(ExportOwnershipRecord record) => _serial(() async {
    final records = await _read();
    final existing = records[record.id];
    if (existing == null || !_sameOwner(existing, record)) {
      throw const FormatException('Export ownership registration changed.');
    }
    records[record.id] = ExportOwnershipRecord.parse(record.toJson());
    await _write(records);
  });

  Future<void> unregister(ExportOwnershipRecord record) => _serial(() async {
    final records = await _read();
    final existing = records[record.id];
    if (existing == null) return;
    if (!_sameOwner(existing, record)) {
      throw const FormatException('Export ownership registration changed.');
    }
    records.remove(record.id);
    await _write(records);
  });

  Future<void> _write(Map<String, ExportOwnershipRecord> records) =>
      _state.write(
        jsonEncode({
          'version': 1,
          'entries': records.values.map((r) => r.toJson()).toList(),
        }),
      );
}
