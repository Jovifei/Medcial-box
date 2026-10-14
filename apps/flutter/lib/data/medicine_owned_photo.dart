import 'dart:io';

/// Receipts are created only for this app's exclusive, newly allocated copy.
/// Legacy picker paths have no receipt and are never physical cleanup targets.
Future<bool> cleanupMedicinePhoto({
  required String supportPath,
  required String draftId,
  required Map<String, dynamic> photo,
  required bool Function() isCurrent,
}) async {
  final owner = photo['ownedLocal'];
  if (owner == null) return false;
  if (owner is! Map || !isCurrent()) return false;
  try {
    final support = Directory(
      await Directory(supportPath).resolveSymbolicLinks(),
    ).absolute;
    final recordedSupport = Directory(owner['supportPath'] as String).absolute;
    final recordedCanonical = Directory(
      await recordedSupport.resolveSymbolicLinks(),
    ).absolute;
    final canonicalRoot = Directory('${support.path}/medicine-draft-images');
    final root = Directory('${recordedSupport.path}/medicine-draft-images');
    final directory = Directory(owner['directory'] as String).absolute;
    final file = File(photo['path'] as String).absolute;
    final purpose = photo['purpose'];
    Uri uri(FileSystemEntity value) => value.uri.normalizePath();
    final name = directory.uri.pathSegments
        .where((part) => part.isNotEmpty)
        .last;
    final fileName = file.uri.pathSegments.last;
    if (!const ['box_front', 'expiry', 'leaflet'].contains(purpose) ||
        owner['draftId'] != draftId ||
        owner['purpose'] != purpose ||
        owner['path'] != photo['path'] ||
        uri(recordedCanonical) != uri(support) ||
        uri(directory.parent) != uri(root) ||
        uri(file.parent) != uri(directory) ||
        !name.startsWith('$draftId-$purpose-') ||
        name == '$draftId-$purpose-' ||
        !const ['original.jpg', 'original.png'].contains(fileName)) {
      return false;
    }
    // SDK support may traverse an OS alias (Android /data/user/0). Only
    // descendants of its canonical root are untrusted cleanup path components.
    if (!isCurrent() ||
        await FileSystemEntity.type(root.path, followLinks: false) !=
            FileSystemEntityType.directory) {
      return false;
    }
    if (uri(Directory(await root.resolveSymbolicLinks())) !=
        uri(canonicalRoot)) {
      return false;
    }
    final directoryType = await FileSystemEntity.type(
      directory.path,
      followLinks: false,
    );
    if (!isCurrent()) return false;
    if (directoryType == FileSystemEntityType.notFound) return true;
    if (directoryType != FileSystemEntityType.directory) return false;
    final canonicalDirectory = Directory(
      await directory.resolveSymbolicLinks(),
    );
    if (!isCurrent() || uri(canonicalDirectory.parent) != uri(canonicalRoot)) {
      return false;
    }
    final type = await FileSystemEntity.type(file.path, followLinks: false);
    if (!isCurrent()) return false;
    if (type == FileSystemEntityType.file) {
      final canonicalFile = File(await file.resolveSymbolicLinks());
      if (!isCurrent() ||
          uri(canonicalFile.parent) != uri(canonicalDirectory)) {
        return false;
      }
      await file.delete();
    } else if (type != FileSystemEntityType.notFound) {
      return false;
    }
    if (!isCurrent()) return false;
    await directory.delete(); // Nonrecursive: unknown siblings are preserved.
    return true;
  } catch (_) {
    return false;
  }
}
