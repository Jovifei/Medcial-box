import 'package:flutter/material.dart';

abstract final class AppColors {
  static const paper = Color(0xFFF7FAF8);
  static const ink = Color(0xFF17382C);
  static const muted = Color(0xFF536A60);
  static const leaf = Color(0xFF087F5B);
  static const leafDeep = Color(0xFF075E45);
  static const mist = Color(0xFFEAF3EE);
  static const line = Color(0xFFDCE7E0);
  static const terracotta = Color(0xFFB42318);
  static const amber = Color(0xFFB45309);
}

ThemeData get appTheme {
  final scheme =
      ColorScheme.fromSeed(
        seedColor: AppColors.leaf,
        brightness: Brightness.light,
      ).copyWith(
        primary: AppColors.leaf,
        onPrimary: Colors.white,
        surface: Colors.white,
        onSurface: AppColors.ink,
        error: AppColors.terracotta,
      );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.paper,
    fontFamily: 'sans',
    textTheme: const TextTheme(
      headlineLarge: TextStyle(
        fontSize: 37,
        height: 1.16,
        fontWeight: FontWeight.w700,
        color: AppColors.ink,
      ),
      headlineMedium: TextStyle(
        fontSize: 28,
        height: 1.2,
        fontWeight: FontWeight.w700,
        color: AppColors.ink,
      ),
      titleLarge: TextStyle(
        fontSize: 22,
        height: 1.25,
        fontWeight: FontWeight.w700,
        color: AppColors.ink,
      ),
      titleMedium: TextStyle(
        fontSize: 18,
        height: 1.3,
        fontWeight: FontWeight.w700,
        color: AppColors.ink,
      ),
      bodyLarge: TextStyle(fontSize: 16, height: 1.55, color: AppColors.ink),
      bodyMedium: TextStyle(fontSize: 16, height: 1.45, color: AppColors.muted),
      bodySmall: TextStyle(fontSize: 14, height: 1.45, color: AppColors.muted),
      labelLarge: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
      labelMedium: TextStyle(
        fontSize: 13,
        height: 1.35,
        fontWeight: FontWeight.w700,
        color: AppColors.muted,
      ),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.paper,
      foregroundColor: AppColors.ink,
      elevation: 0,
      centerTitle: false,
    ),
    inputDecorationTheme: const InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 15),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(16)),
        borderSide: BorderSide(color: AppColors.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(16)),
        borderSide: BorderSide(color: AppColors.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(16)),
        borderSide: BorderSide(color: AppColors.leaf, width: 1.5),
      ),
    ),
    cardTheme: const CardThemeData(
      color: Colors.white,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(22)),
        side: BorderSide(color: AppColors.line),
      ),
    ),
  );
}
