import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'core/motion/app_motion.dart';
import 'core/theme/app_theme.dart';
import 'data/demo_repositories.dart';
import 'features/export/export_page.dart';
import 'features/family/family_choice_page.dart';
import 'features/home/home_page.dart';
import 'features/medicine/medicine_detail_page.dart';
import 'features/welcome/welcome_page.dart';

class HomeMedicineApp extends StatefulWidget {
  const HomeMedicineApp({super.key});

  @override
  State<HomeMedicineApp> createState() => _HomeMedicineAppState();
}

class _HomeMedicineAppState extends State<HomeMedicineApp> {
  late final DemoMedicineRepository medicineRepository;
  late final GoRouter router;

  @override
  void initState() {
    super.initState();
    medicineRepository = DemoMedicineRepository();
    router = GoRouter(
      initialLocation: '/welcome',
      routes: [
        _route('/welcome', const WelcomePage()),
        _route('/family-choice', const FamilyChoicePage()),
        _route('/home', HomePage(repository: medicineRepository)),
        GoRoute(
          path: '/medicine/:id',
          pageBuilder: (context, state) => _transitionPage(
            state,
            MedicineDetailPage(
              repository: medicineRepository,
              medicineId: state.pathParameters['id']!,
            ),
          ),
        ),
        _route('/export', ExportPage(repository: medicineRepository)),
      ],
    );
  }

  GoRoute _route(String path, Widget child) => GoRoute(
    path: path,
    pageBuilder: (context, state) => _transitionPage(state, child),
  );

  CustomTransitionPage<void> _transitionPage(
    GoRouterState state,
    Widget child,
  ) {
    return CustomTransitionPage<void>(
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
              begin: const Offset(0.035, 0),
              end: Offset.zero,
            ).animate(curved),
            child: child,
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: '家庭药箱 · Flutter 原型',
      debugShowCheckedModeBanner: false,
      theme: appTheme,
      routerConfig: router,
    );
  }
}
