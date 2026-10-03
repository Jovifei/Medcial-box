import 'package:flutter/foundation.dart';

import 'api_auth_repository.dart';
import 'api_client.dart';
import 'api_medicine_repository.dart';
import 'api_plan_repository.dart';
import 'api_workflow_repository.dart';
import 'app_stores.dart';
import 'demo_repositories.dart';
import 'local_reminder_service.dart';

class AppServices {
  AppServices._({
    required this.apiBaseUrl,
    required this.configurationError,
    required this.secretStore,
    required this.localStore,
    required this.demoMedicineRepository,
    required this.reminders,
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

  final ValueNotifier<bool> sessionInvalidated = ValueNotifier(false);
  final ValueNotifier<bool> familyInvalidated = ValueNotifier(false);

  bool get isConfigured => api != null && configurationError == null;

  static Future<AppServices> create({
    required String apiBaseUrl,
    SecretStore? secretStore,
    LocalAppStore? localStore,
  }) async {
    final secrets = secretStore ?? FlutterSecretStore();
    final local = IdentityLocalStore(
      localStore ?? await SharedPreferencesAppStore.create(),
    );
    final baseUrl = apiBaseUrl.trim();
    if (baseUrl.isEmpty) {
      return AppServices._(
        apiBaseUrl: baseUrl,
        configurationError: null,
        secretStore: secrets,
        localStore: local,
        demoMedicineRepository: DemoMedicineRepository(),
        reminders: LocalReminderService(),
      );
    }
    try {
      final api = ApiClient(
        baseUrl: baseUrl,
        tokenProvider: () => secrets.read(ApiAuthRepository.accessTokenKey),
      );
      final plans = ApiPlanRepository(api: api, localStore: local);
      final workflow = ApiWorkflowRepository(api: api);
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
        final clearExports = workflow.exportFiles.resetForIdentity();
        final epoch = api.identityEpoch;
        scheduleRequest++;
        // Keep protected routes closed until every private cleanup succeeds.
        services.familyInvalidated.value = true;
        medicines.clearSessionSnapshot();
        final clearStorage = local.clearFamilyData();
        await Future.wait([
          reminders.resetForIdentity(),
          clearStorage,
          clearExports,
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
        ),
        families: ApiFamilyRepository(
          api: api,
          localStore: local,
          onFamilyChanged: clearIdentityData,
        ),
        medicines: medicines,
        workflow: workflow,
        plans: plans,
        demoMedicineRepository: DemoMedicineRepository(),
        reminders: reminders,
      );
      api.onFamilyUnavailable = () => clearIdentityData(familyMissing: true);
      api.onUnauthorized = () async {
        services.sessionInvalidated.value = true;
        try {
          await clearIdentityData();
        } finally {
          // Revoked credentials cannot survive a separate native cleanup error.
          await secrets.delete(ApiAuthRepository.accessTokenKey);
          services.sessionInvalidated.value = true;
        }
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
      );
    }
  }
}
