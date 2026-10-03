import 'dart:convert';

import 'package:home_medicine_flutter/data/app_stores.dart';
import 'package:home_medicine_flutter/models/medicine_models.dart';
import 'package:home_medicine_flutter/data/private_atomic_state.dart';
import 'package:home_medicine_flutter/data/session_identity_state.dart';

final _stores = Expando<MemoryPrivateAtomicState>();

/// Existing production integration fixtures deliberately establish a synthetic
/// accepted session, rather than relying on insecure legacy-token migration.
Future<MemoryPrivateAtomicState> identityFixture(
  MemorySecretStore secrets, {
  LocalAppStore? localStore,
  String userId = 'synthetic-user',
}) async {
  final existing = _stores[secrets];
  if (existing != null) return existing;
  final store = MemoryPrivateAtomicState();
  _stores[secrets] = store;
  final token = secrets.values[SessionIdentityState.accessTokenKey];
  final state = SessionIdentityState(
    origin: 'https://medicine.example',
    secrets: secrets,
    persistence: store,
  );
  await state.initialize();
  if (token != null) {
    state.finishLegacyQuarantine();
    final link = state.beginLink();
    await state.acceptToken(link, token);
    // Model a prior successful server profile for these normal-session
    // fixtures. Missing/corrupt-owner behavior has separate explicit tests.
    final family =
        await localStore?.readFamily() ??
        FamilyRecord(
          id: 'family-a',
          name: 'Synthetic established family',
          role: 'member',
        );
    await localStore?.saveFamily(family);
    await state.recordOwner(
      expectedGeneration: state.generation!,
      userId: userId,
      familyId: family.id,
      isCurrent: () => true,
    );
  }
  return store;
}

String? storedSyntheticToken(MemorySecretStore secrets) {
  final raw = secrets.values[SessionIdentityState.accessTokenKey];
  if (raw == null) return null;
  final value = jsonDecode(raw) as Map;
  return value['token'] as String;
}
