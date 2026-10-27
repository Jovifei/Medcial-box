import 'dart:convert';

/// A candidate is tied to stable local photo IDs, never list positions.
class RecognitionCandidate {
  RecognitionCandidate(this.value, this.photoIds);
  final Object value;
  final List<String> photoIds;
}

class RecognitionFieldSource {
  const RecognitionFieldSource({
    required this.source,
    required this.photoIds,
    required this.reviewed,
    this.candidateSignature,
  });
  final String source;
  final List<String> photoIds;
  final bool reviewed;
  final String? candidateSignature;

  Map<String, dynamic> toJson() => {
    'source': source,
    'photoIds': photoIds,
    'reviewed': reviewed,
    if (candidateSignature != null) 'candidateSignature': candidateSignature,
  };
}

class RecognitionReview {
  RecognitionReview();

  RecognitionReview.fromJson(Object? json) {
    if (json is! Map) return;
    for (final entry in json.entries) {
      final value = entry.value;
      if (entry.key is! String || value is! Map || value['source'] is! String) {
        continue;
      }
      _sources[entry.key as String] = RecognitionFieldSource(
        source: value['source'] as String,
        photoIds: (value['photoIds'] as List? ?? [])
            .whereType<String>()
            .toList(),
        reviewed: value['reviewed'] == true,
        candidateSignature: value['candidateSignature'] as String?,
      );
    }
  }

  final Map<String, RecognitionFieldSource> _sources = {};

  RecognitionFieldSource? source(String field) => _sources[field];

  Map<String, dynamic> toJson() => {
    for (final entry in _sources.entries) entry.key: entry.value.toJson(),
  };

  bool canAutoApply(String field) {
    final source = _sources[field]?.source;
    return source == null || source == 'recognized';
  }

  void markManual(String field) =>
      _sources[field] = const RecognitionFieldSource(
        source: 'manual',
        photoIds: [],
        reviewed: true,
      );

  void markCatalog(String field) =>
      _sources[field] = const RecognitionFieldSource(
        source: 'catalog',
        photoIds: [],
        reviewed: false,
      );

  static Object? _normalize(Object? value) {
    if (value is String) {
      final text = value.trim();
      return text.isEmpty ? null : text;
    }
    if (value is List) {
      final items = value
          .whereType<String>()
          .map((s) => s.trim())
          .where((s) => s.isNotEmpty)
          .toList();
      return items.isEmpty ? null : items;
    }
    return null;
  }

  List<RecognitionCandidate> candidates(
    String field,
    List<Map<String, dynamic>> photos,
  ) {
    final values = <String, RecognitionCandidate>{};
    for (final photo in photos) {
      final id = photo['clientPhotoId'];
      final fields = photo['recognitionFields'];
      if (id is! String || fields is! Map) continue;
      final value = _normalize(fields[field]);
      if (value == null) continue;
      final key = jsonEncode(value);
      final candidate = values.putIfAbsent(
        key,
        () => RecognitionCandidate(value, []),
      );
      if (!candidate.photoIds.contains(id)) candidate.photoIds.add(id);
    }
    return values.values.toList();
  }

  String _signature(List<RecognitionCandidate> candidates) {
    final values =
        candidates.map((candidate) => jsonEncode(candidate.value)).toList()
          ..sort();
    return jsonEncode(values);
  }

  bool requiresChoice(String field, List<Map<String, dynamic>> photos) {
    final options = candidates(field, photos);
    if (options.length < 2) return false;
    final selected = source(field);
    if (selected != null && selected.source != 'recognized') return false;
    return selected == null ||
        !selected.reviewed ||
        selected.candidateSignature != _signature(options);
  }

  void accept(
    String field,
    RecognitionCandidate candidate,
    List<Map<String, dynamic>> photos, {
    required bool reviewed,
  }) {
    _sources[field] = RecognitionFieldSource(
      source: 'recognized',
      photoIds: List.of(candidate.photoIds),
      reviewed: reviewed,
      candidateSignature: reviewed
          ? _signature(candidates(field, photos))
          : null,
    );
  }

  void removePhoto(String id) {
    for (final entry in _sources.entries.toList()) {
      final source = entry.value;
      if (source.source != 'recognized' || !source.photoIds.contains(id)) {
        continue;
      }
      final remaining = source.photoIds
          .where((photoId) => photoId != id)
          .toList();
      _sources[entry.key] = RecognitionFieldSource(
        source: remaining.isEmpty ? 'removed' : 'recognized',
        photoIds: remaining,
        reviewed: source.reviewed,
        candidateSignature: source.candidateSignature,
      );
    }
  }
}
