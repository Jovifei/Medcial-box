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

  bool get isConfigured => api != null && configurationError == null;

  static Future<AppServices> create({
    required String apiBaseUrl,
    SecretStore? secretStore,
    LocalAppStore? localStore,
  }) async {
    final secrets = secretStore ?? FlutterSecretStore();
    final local = localStore ?? await SharedPreferencesAppStore.create();
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
      final medicines = ApiMedicineRepository(api: api, localStore: local);
      final reminders = LocalReminderService()..watch(medicines);
      // 统一的身份切换清理：内存快照 + 本机家庭数据一起作废，
      // 保证换账号/换家庭后看不到上一个家庭的库存（A03）。
      Future<void> clearIdentityData() async {
        medicines.clearSessionSnapshot();
        await local.clearFamilyData();
      }
      // 401 表示会话已在服务端失效：清理内存快照/本机家庭数据并删除令牌，
      // 让 BootGate 下次进入时路由到连接页，而不是停留在过期会话上（R10）。
      api.onUnauthorized = () async {
        await clearIdentityData();
        await secrets.delete(ApiAuthRepository.accessTokenKey);
      };
      return AppServices._(
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
        ),
        families: ApiFamilyRepository(
          api: api,
          localStore: local,
          onFamilyChanged: clearIdentityData,
        ),
        medicines: medicines,
        workflow: ApiWorkflowRepository(api: api),
        plans: ApiPlanRepository(api: api),
        demoMedicineRepository: DemoMedicineRepository(),
        reminders: reminders,
      );
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
