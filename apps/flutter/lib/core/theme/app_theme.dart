import 'package:flutter/material.dart';

abstract final class AppColors {
  static const paper = Color(0xFFF5F7F4);
  static const ink = Color(0xFF24352C);
  static const muted = Color(0xFF718078);
  static const leaf = Color(0xFF3F7D5C);
  static const leafDeep = Color(0xFF315F46);
  static const mist = Color(0xFFE7F0E9);
  static const line = Color(0xFFE4EBE5);
  static const terracotta = Color(0xFFA45437);
  static const amber = Color(0xFF9A6B21);
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
        fontSize: 17,
        height: 1.3,
        fontWeight: FontWeight.w700,
        color: AppColors.ink,
      ),
      bodyLarge: TextStyle(fontSize: 16, height: 1.55, color: AppColors.ink),
      bodyMedium: TextStyle(fontSize: 14, height: 1.45, color: AppColors.muted),
      labelLarge: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
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
      ),
    ),
  );
}
