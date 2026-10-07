import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:go_router/go_router.dart';

import 'core/motion/app_motion.dart';
import 'core/theme/app_theme.dart';
import 'data/api_auth_repository.dart';
import 'data/app_services.dart';
import 'data/app_stores.dart';
import 'data/private_atomic_state.dart';
import 'data/notification_tap_handler.dart';
import 'features/auth/device_link_page.dart';
import 'features/export/export_api_page.dart';
import 'features/export/export_page.dart';
import 'features/family/family_choice_api_page.dart';
import 'features/family/family_choice_page.dart';
import 'features/home/home_page.dart';
import 'features/home/production_shell.dart';
import 'features/medicine/medicine_detail_api_page.dart';
import 'features/medicine/medicine_detail_page.dart';
import 'features/medicine/medicine_entry_api_page.dart';
import 'features/medicine/leaflet_photo_page.dart';
import 'features/my/trash_audit_pages.dart';
import 'features/my/release_notes_page.dart';
import 'features/pending/stocktake_page.dart';
import 'features/pending/pending_page.dart';
import 'features/plan/care_permissions_page.dart';
import 'features/plan/care_profiles_page.dart';
import 'features/plan/plan_detail_page.dart';
import 'features/plan/plan_form_page.dart';
import 'features/plan/plan_history_page.dart';
import 'features/welcome/welcome_page.dart';

const _appLocale = Locale('zh', 'CN');
const _appLocalizationsDelegates = [
  GlobalMaterialLocalizations.delegate,
  GlobalWidgetsLocalizations.delegate,
  GlobalCupertinoLocalizations.delegate,
];

class HomeMedicineApp extends StatefulWidget {
  const HomeMedicineApp({
    super.key,
    this.apiBaseUrl,
    this.secretStore,
    this.localStore,
    this.identityStore,
    this.initialLocation = '/',
  });

  final String? apiBaseUrl;
  final SecretStore? secretStore;
  final LocalAppStore? localStore;
  final PrivateAtomicState? identityStore;
  final String initialLocation;

  @override
  State<HomeMedicineApp> createState() => _HomeMedicineAppState();
}

class _HomeMedicineAppState extends State<HomeMedicineApp> {
  late final Future<AppServices> servicesFuture = AppServices.create(
    apiBaseUrl: widget.apiBaseUrl ?? apiBaseUrlFromBuild,
    secretStore: widget.secretStore,
    localStore: widget.localStore,
    identityStore: widget.identityStore,
  );
  GoRouter? router;
  NotificationTapHandler? notificationTaps;
  AppServices? activeServices;

  @override
  void dispose() {
    activeServices?.reminders.onNotificationTap = null;
    notificationTaps?.dispose();
    router?.dispose();
    super.dispose();
  }

  GoRouter _createRouter(AppServices services) {
    final routes = <RouteBase>[
      _route('/', BootGatePage(services: services)),
    ];
    if (kDebugMode) {
      final demo = services.demoMedicineRepository;
      routes.addAll([
        // Synthetic walkthrough is a development aid and is not routable in Release.
        _route('/demo/welcome', const WelcomePage()),
        _route('/demo/family-choice', const FamilyChoicePage()),
        _route('/demo/home', HomePage(repository: demo)),
        GoRoute(
          path: '/demo/medicine/:id',
          pageBuilder: (context, state) => _transitionPage(
            state,
            MedicineDetailPage(
              repository: demo,
              medicineId: state.pathParameters['id']!,
            ),
          ),
        ),
        _route('/demo/export', ExportPage(repository: demo)),
      ]);
    }
    if (services.isConfigured) {
      routes.addAll([
        _route(
          '/connect',
          localAppTrialFromBuild
              ? BootGatePage(services: services)
              : DeviceLinkPage(services: services),
        ),
        _route(
          '/family-choice',
          FamilyChoiceApiPage(repository: services.families!),
        ),
        GoRoute(
          path: '/home',
          pageBuilder: (context, state) => _transitionPage(
            state,
            ProductionShell(
              services: services,
              initialTab: switch (state.uri.queryParameters['tab']) {
                'plans' => 1,
                'pending' => 2,
                'my' => 3,
                _ => 0,
              },
            ),
          ),
        ),
        _route('/restock', PendingPage(services: services, restockOnly: true)),
        _route(
          '/medicine/new',
          MedicineEntryApiPage(
            repository: services.medicines!,
            workflow: services.workflow!,
            localStore: services.localStore,
          ),
        ),
        GoRoute(
          path: '/medicine/:id',
          pageBuilder: (context, state) => _transitionPage(
            state,
            MedicineDetailApiPage(
              repository: services.medicines!,
              workflow: services.workflow!,
              medicineId: state.pathParameters['id']!,
            ),
          ),
        ),
        GoRoute(
          path: '/medicine/:id/leaflet-photos',
          pageBuilder: (context, state) => _transitionPage(
            state,
            LeafletPhotoPage(
              repository: services.workflow!,
              medicineId: state.pathParameters['id']!,
            ),
          ),
        ),
        _route(
          '/export',
          ExportApiPage(
            repository: services.medicines!,
            workflow: services.workflow!,
          ),
        ),
        GoRoute(
          path: '/stocktake/:stocktakeId',
          pageBuilder: (context, state) => _transitionPage(
            state,
            StocktakePage(
              repository: services.medicines!,
              workflow: services.workflow!,
              stocktakeId: state.pathParameters['stocktakeId']!,
            ),
          ),
        ),
        _route(
          '/trash',
          TrashPage(
            workflow: services.workflow!,
            medicines: services.medicines!,
          ),
        ),
        _route('/audit', AuditPage(workflow: services.workflow!)),
        _route('/release-notes', const ReleaseNotesPage()),
        _route('/plans/new', PlanFormPage(repository: services.plans!)),
        GoRoute(
          path: '/plan/:id',
          pageBuilder: (context, state) => _transitionPage(
            state,
            PlanDetailPage(
              repository: services.plans!,
              planId: state.pathParameters['id']!,
            ),
          ),
        ),
        GoRoute(
          path: '/plan/:id/edit',
          pageBuilder: (context, state) => _transitionPage(
            state,
            PlanFormPage(
              repository: services.plans!,
              planId: state.pathParameters['id']!,
            ),
          ),
        ),
        GoRoute(
          path: '/plan/:id/history',
          pageBuilder: (context, state) => _transitionPage(
            state,
            PlanHistoryPage(
              repository: services.plans!,
              planId: state.pathParameters['id']!,
            ),
          ),
        ),
        _route(
          '/care-profiles',
          CareProfilesPage(
            repository: services.plans!,
            families: services.families!,
          ),
        ),
        GoRoute(
          path: '/care-profiles/:id/permissions',
          pageBuilder: (context, state) => _transitionPage(
            state,
            CarePermissionsPage(
              repository: services.plans!,
              families: services.families!,
              careProfileId: state.pathParameters['id']!,
            ),
          ),
        ),
      ]);
    }
    final createdRouter = GoRouter(
      initialLocation: widget.initialLocation,
      refreshListenable: Listenable.merge([
        services.sessionInvalidated,
        services.familyInvalidated,
      ]),
      redirect: (context, state) {
        if (kDebugMode && state.matchedLocation.startsWith('/demo')) return null;
        if (services.sessionInvalidated.value) {
          return state.matchedLocation == '/connect' ? null : '/connect';
        }
        if (services.familyInvalidated.value &&
            state.matchedLocation != '/family-choice' &&
            state.matchedLocation != '/connect') {
          return '/family-choice';
        }
        if (services.isConfigured &&
            (services.api!.identityState?.owner == null ||
                !services.offlineCacheMatchesOwner) &&
            state.matchedLocation != '/' &&
            state.matchedLocation != '/connect' &&
            state.matchedLocation != '/family-choice') {
          return '/';
        }
        return null;
      },
      routes: routes,
      errorBuilder: (context, state) => Scaffold(
        appBar: AppBar(title: const Text('页面未找到')),
        body: Center(
          child: TextButton(
            onPressed: () => context.go('/'),
            child: const Text('返回家庭药箱'),
          ),
        ),
      ),
    );
    activeServices = services;
    if (services.isConfigured) {
      notificationTaps = NotificationTapHandler(
        repository: services.plans!,
        navigate: createdRouter.go,
      );
      // Defer binding until the router is mounted; this also consumes buffered
      // launch payloads exactly once, regardless of which page is initially open.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        services.reminders.onNotificationTap = (payload) {
          unawaited(notificationTaps!.handle(payload));
        };
      });
    }
    return createdRouter;
  }

  GoRoute _route(String path, Widget child) => GoRoute(
    path: path,
    pageBuilder: (context, state) => _transitionPage(state, child),
  );

  CustomTransitionPage<void> _transitionPage(
    GoRouterState state,
    Widget child,
  ) => CustomTransitionPage<void>(
    key: state.pageKey,
    child: child,
    transitionDuration: AppMotion.route,
    reverseTransitionDuration: AppMotion.route,
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      final curved = CurvedAnimation(
        parent: animation,
        curve: Curves.easeOutCubic,
      );
      return FadeTransition(
        opacity: curved,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(.035, 0),
            end: Offset.zero,
          ).animate(curved),
          child: child,
        ),
      );
    },
  );

  @override
  Widget build(BuildContext context) => FutureBuilder<AppServices>(
    future: servicesFuture,
    builder: (context, snapshot) {
      if (snapshot.hasError) {
        return MaterialApp(
          theme: appTheme,
          locale: _appLocale,
          supportedLocales: const [_appLocale],
          localizationsDelegates: _appLocalizationsDelegates,
          home: const Scaffold(
            body: Center(child: Text('应用初始化失败，请重启后重试；若持续出现，请联系维护者。')),
          ),
        );
      }
      if (!snapshot.hasData) {
        return MaterialApp(
          title: 'JF小药箱',
          theme: appTheme,
          locale: _appLocale,
          supportedLocales: const [_appLocale],
          localizationsDelegates: _appLocalizationsDelegates,
          home: const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          ),
        );
      }
      router ??= _createRouter(snapshot.data!);
      return MaterialApp.router(
        title: 'JF小药箱',
        debugShowCheckedModeBanner: false,
        theme: appTheme,
        locale: _appLocale,
        supportedLocales: const [_appLocale],
        localizationsDelegates: _appLocalizationsDelegates,
        builder: (context, child) => localAppTrialFromBuild
            ? Banner(
                message: '本机试用',
                location: BannerLocation.topEnd,
                child: child!,
              )
            : child!,
        routerConfig: router!,
      );
    },
  );
}
