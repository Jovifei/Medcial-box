import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api_auth_repository.dart';
import 'api_client.dart';
import 'api_medicine_repository.dart';
import 'api_plan_repository.dart';
import 'api_workflow_repository.dart';
import 'app_stores.dart';
import 'demo_repositories.dart';
import 'export_temporary_store.dart';
import 'local_reminder_service.dart';
import 'private_atomic_state.dart';
import 'session_identity_state.dart';

class AppServices {
  AppServices._({
    required this.apiBaseUrl,
    required this.configurationError,
    required this.secretStore,
    required this.localStore,
    required this.demoMedicineRepository,
    required this.reminders,
    required this.exportFiles,
    required this.exportRecovery,
    this.api,
    this.auth,
    this.families,
    this.medicines,
    this.workflow,
    this.plans,
  });

  final String apiBaseUrl;
  final String? configurationError;
  final SecretStore secretStore;
  final LocalAppStore localStore;
  final ApiClient? api;
  final ApiAuthRepository? auth;
  final ApiFamilyRepository? families;
  final ApiMedicineRepository? medicines;
  final ApiWorkflowRepository? workflow;
  final ApiPlanRepository? plans;
  final DemoMedicineRepository demoMedicineRepository;
  final LocalReminderService reminders;
  final ExportTemporaryStore exportFiles;
  // Settles the shared startup attempt, including a typed export-only failure.
  // This Future is deliberately not an authentication/ordinary-work gate.
  final Future<void> exportRecovery;
  List<ExportRecoveryIssue> get exportRecoveryIssues =>
      exportFiles.recoveryIssues;

  bool offlineCacheMatchesOwner = false;
  final ValueNotifier<bool> sessionInvalidated = ValueNotifier(false);
  final ValueNotifier<bool> familyInvalidated = ValueNotifier(false);

  bool get isConfigured => api != null && configurationError == null;

  static Future<AppServices> create({
    required String apiBaseUrl,
    SecretStore? secretStore,
    LocalAppStore? localStore,
    PrivateAtomicState? identityStore,
    ExportTemporaryStore? exportFiles,
  }) async {
    final secrets = secretStore ?? FlutterSecretStore();
    final local = IdentityLocalStore(
      localStore ?? await SharedPreferencesAppStore.create(),
    );
    final exports = exportFiles ?? ExportTemporaryStore();
    final exportRecovery = exports.recoverForStartup();
    final baseUrl = apiBaseUrl.trim();
    if (baseUrl.isEmpty) {
      return AppServices._(
        apiBaseUrl: baseUrl,
        configurationError: null,
        secretStore: secrets,
        localStore: local,
        demoMedicineRepository: DemoMedicineRepository(),
        reminders: LocalReminderService(),
        exportFiles: exports,
        exportRecovery: exportRecovery,
      );
    }
    try {
      // Validate/normalize the API before any stored credential is considered.
      final identity = SessionIdentityState(
        origin: ApiClient.normalizeBaseUrl(baseUrl),
        secrets: secrets,
        persistence: identityStore ?? FilePrivateAtomicState(),
      );
      await identity.initialize();
      final cachedFamily = await local.readFamily();
      final owner = identity.owner;
      final mismatchedCache =
          identity.accepted &&
          (owner == null ||
              owner.familyId == null ||
              cachedFamily?.id != owner.familyId);
      if (mismatchedCache) {
        await local.quarantineLegacyFamilyData(
          preserveVerifiedPlanScope: owner?.familyId == null
              ? null
              : SessionIdentityState.scopeForOwner(owner!),
        );
      }
      final api = ApiClient(
        baseUrl: baseUrl,
        tokenProvider: identity.readAccessToken,
        identityState: identity,
      );
      final plans = ApiPlanRepository(api: api, localStore: local);
      final workflow = ApiWorkflowRepository(api: api, exportFiles: exports);
      final medicines = ApiMedicineRepository(api: api, localStore: local);
      final reminders = LocalReminderService()..watch(medicines);
      var scheduleRequest = 0;
      plans.onMutationAcknowledged = (epoch) {
        if (epoch != api.identityEpoch) return Future.value();
        scheduleRequest++;
        // A confirmed write invalidates dose occurrences even if the following
        // read is offline. Keep the family's stock reminder projection intact.
        return reminders.setSchedules(
          const [],
          identityEpoch: reminders.identityEpoch,
        );
      };
      plans.onChanged = () async {
        final request = ++scheduleRequest;
        final epoch = reminders.identityEpoch;
        try {
          final preferences = await workflow.notificationPreferences();
          if (epoch != reminders.identityEpoch || request != scheduleRequest) {
            return;
          }
          reminders.stockReminderTime =
              preferences['stockReminderTime'] as String? ?? '09:00';
          final channels =
              preferences['channels'] as List<dynamic>? ?? const [];
          if (!channels.contains('android')) {
            await reminders.disable();
            return;
          }
          final schedules = await plans.reminderSchedules();
          if (request != scheduleRequest) return;
          await reminders.setSchedules(schedules, identityEpoch: epoch);
        } catch (_) {
          if (request != scheduleRequest) return;
          // A failed read does not prove that the saved reminder projection
          // was revoked. Current family/session loss is handled by ApiClient;
          // a successful empty projection removes revoked dose reminders.
        }
      };
      // 统一的身份切换清理：内存快照 + 本机家庭数据一起作废，
      // 保证换账号/换家庭后看不到上一个家庭的库存（A03）。
      late final AppServices services;
      Future<void> clearIdentityData({bool familyMissing = false}) async {
        api.invalidateIdentity();
        final clearOwner = identity.clearFamily();
        services.offlineCacheMatchesOwner = false;
        plans.formDrafts.resetForIdentity();
        final clearExports = workflow.exportFiles.resetForIdentity();
        final epoch = api.identityEpoch;
        scheduleRequest++;
        // Keep protected routes closed until every private cleanup succeeds.
        services.familyInvalidated.value = true;
        medicines.clearSessionSnapshot();
        final clearStorage = identity.requiresLegacyQuarantine
            ? local.quarantineLegacyFamilyData().then(
                (_) => identity.finishLegacyQuarantine(),
              )
            : local.clearFamilyData();
        await Future.wait([
          reminders.resetForIdentity(),
          clearStorage,
          clearExports,
          clearOwner,
        ]);
        if (epoch == api.identityEpoch) {
          services.familyInvalidated.value = familyMissing;
        }
      }

      services = AppServices._(
        apiBaseUrl: baseUrl,
        configurationError: null,
        secretStore: secrets,
        localStore: local,
        api: api,
        auth: ApiAuthRepository(
          api: api,
          secretStore: secrets,
          localStore: local,
          onIdentitySwitch: clearIdentityData,
          onLoggedOut: () => services.sessionInvalidated.value = true,
          onOwnerValidated: (owner) async {
            if (owner.familyId == null) return;
            final epoch = api.identityEpoch;
            final scope = SessionIdentityState.scopeForOwner(owner);
            if (identity.owner != owner || epoch != api.identityEpoch) return;
            if (identity.canRestoreLegacyScope(scope)) {
              await local.adoptLegacyPlanDrafts(scope);
            }
            final family = await local.readFamily();
            if (identity.owner == owner && epoch == api.identityEpoch) {
              services.offlineCacheMatchesOwner = family?.id == owner.familyId;
              services.familyInvalidated.value = false;
            }
          },
        ),
        families: ApiFamilyRepository(
          api: api,
          localStore: local,
          onFamilyChanged: clearIdentityData,
          onFamilyValidated: () async {
            final context = identity.owner;
            final family = await local.readFamily();
            if (context != null && identity.owner == context) {
              services.offlineCacheMatchesOwner =
                  context.familyId != null && family?.id == context.familyId;
              if (services.offlineCacheMatchesOwner) {
                services.familyInvalidated.value = false;
              }
            }
          },
        ),
        medicines: medicines,
        workflow: workflow,
        plans: plans,
        demoMedicineRepository: DemoMedicineRepository(),
        reminders: reminders,
        exportFiles: exports,
        exportRecovery: exportRecovery,
      );
      services.offlineCacheMatchesOwner =
          !mismatchedCache &&
          owner != null &&
          owner.familyId != null &&
          cachedFamily?.id == owner.familyId;
      if (mismatchedCache) await reminders.resetForIdentity();
      services.sessionInvalidated.value = !identity.accepted;
      identity.onBlocked = () {
        if (!services.sessionInvalidated.value) api.invalidateIdentity();
        plans.formDrafts.resetForIdentity();
        medicines.clearSessionSnapshot();
        services.sessionInvalidated.value = true;
        // Storage failure is not permission to discard unknown local drafts.
        // Private in-memory/native projections close immediately; explicit
        // identity acceptance still passes the normal full cleanup barrier.
        unawaited(
          Future.wait([
            reminders.resetForIdentity(),
            workflow.exportFiles.resetForIdentity(),
          ]).then<void>((_) {}, onError: (Object _) {}),
        );
      };
      api.refreshIdentityContext = () async {
        await services.auth!.getCurrentUser();
        return identity.owner;
      };
      api.onFamilyUnavailable = () => clearIdentityData(familyMissing: true);
      api.onUnauthorized = () async {
        final intent = identity.beginSignOut();
        api.invalidateIdentity();
        services.sessionInvalidated.value = true;
        Object? failure;
        try {
          await identity.persistSignOut(intent);
        } catch (error) {
          failure = error;
        }
        try {
          await clearIdentityData();
        } catch (error) {
          failure ??= error;
        }
        try {
          await identity.deleteSignedOutSecrets(intent);
        } catch (error) {
          failure ??= error;
        }
        if (identity.isSignOutCurrent(intent)) {
          services.sessionInvalidated.value = true;
        }
        if (failure != null) throw failure;
      };
      return services;
    } on ArgumentError catch (error) {
      return AppServices._(
        apiBaseUrl: baseUrl,
        configurationError: error.message as String? ?? '服务地址格式错误。',
        secretStore: secrets,
        localStore: local,
        demoMedicineRepository: DemoMedicineRepository(),
        reminders: LocalReminderService(),
        exportFiles: exports,
        exportRecovery: exportRecovery,
      );
    }
  }
}
