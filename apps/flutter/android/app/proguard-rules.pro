# google_mlkit_text_recognition 0.17.1 references these optional compileOnly
# models from its native script switch. Medicine OCR selects Chinese only;
# Chinese 16.0.1 is bundled in build.gradle.kts, and Latin is bundled by the plugin.
# Keep this list exact so missing classes for either supported model still fail
# release builds. Before enabling another script, bundle its model and remove
# the matching rules below.
-dontwarn com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions
-dontwarn com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions$Builder
-dontwarn com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
-dontwarn com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions$Builder
-dontwarn com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
-dontwarn com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions$Builder
