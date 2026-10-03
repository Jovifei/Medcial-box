import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../core/widgets/app_surfaces.dart';
import '../../data/api_auth_repository.dart';
import '../../data/api_client.dart';
import '../../data/app_services.dart';

class BootGatePage extends StatefulWidget {
  const BootGatePage({super.key, required this.services});
  final AppServices services;

  @override
  State<BootGatePage> createState() => _BootGatePageState();
}

class _BootGatePageState extends State<BootGatePage> {
  String? error;
  bool resolving = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _resolve());
  }

  Future<void> _resolve() async {
    if (!mounted || resolving) return;
    final services = widget.services;
    if (!services.isConfigured) {
      setState(() => resolving = false);
      return;
    }
    setState(() {
      resolving = true;
      error = null;
    });
    final token = await services.auth!.readAccessToken();
    if (!mounted) return;
    if (token == null || token.isEmpty) {
      context.go('/connect');
      return;
    }
    try {
      final profile = await services.auth!.getCurrentUser();
      if (!mounted) return;
      services.sessionInvalidated.value = false;
      if (profile.hasFamily && profile.family != null) {
        context.go('/home');
      } else {
        // The authenticated repository already completed guarded family cleanup.
        if (mounted) context.go('/family-choice');
      }
    } on ApiNetworkException {
      final family = await services.localStore.readFamily();
      if (!mounted) return;
      if (family != null) {
        context.go('/home');
      } else {
        setState(() {
          resolving = false;
          error = '当前无法连接服务。检查网络，或稍后重试。';
        });
      }
    } on ApiException catch (exception) {
      if (exception.statusCode == 401 && services.sessionInvalidated.value) {
        // ApiClient owns token cleanup. A late response/STALE_SESSION must not
        // delete a newer credential or force its authenticated route to login.
        if (mounted) context.go('/connect');
      } else if (mounted) {
        setState(() {
          resolving = false;
          error = friendlyApiError(exception);
        });
      }
    } catch (exception) {
      if (!mounted) return;
      setState(() {
        resolving = false;
        error = friendlyApiError(exception);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.services.isConfigured) {
      return Scaffold(
        body: AppPage(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: AppCard(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.cloud_off_rounded, size: 36),
                    const SizedBox(height: 16),
                    Text(
                      '先配置药箱服务',
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 10),
                    Text(
                      widget.services.configurationError ??
                          missingApiConfigurationMessage,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 14),
                    SelectableText(
                      'flutter run --dart-define=API_BASE_URL=https://你的药箱域名',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 10),
                    const Text(
                      'Android 模拟器访问本机服务时通常使用 10.0.2.2；真机请使用本机局域网地址或 HTTPS 域名。',
                    ),
                    const SizedBox(height: 14),
                    SoftButton(
                      label: '查看演示界面',
                      onPressed: () => context.go('/demo/welcome'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }
    return Scaffold(
      body: AppPage(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 18),
              Text(error ?? (resolving ? '正在恢复家庭药箱…' : '正在检查登录状态…')),
              if (error != null) ...[
                const SizedBox(height: 14),
                SoftButton(label: '重试', onPressed: _resolve),
                TextButton(
                  onPressed: () => context.go('/connect'),
                  child: const Text('重新连接'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class DeviceLinkPage extends StatefulWidget {
  const DeviceLinkPage({super.key, required this.services});
  final AppServices services;

  @override
  State<DeviceLinkPage> createState() => _DeviceLinkPageState();
}

class _DeviceLinkPageState extends State<DeviceLinkPage> {
  DeviceLink? link;
  Timer? pollTimer;
  bool starting = false;
  bool polling = false;
  String? message;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    pollTimer?.cancel();
    setState(() {
      starting = true;
      link = null;
      message = null;
    });
    try {
      final result = await widget.services.auth!.startDeviceLink();
      if (!mounted) return;
      setState(() {
        link = result;
        starting = false;
        message = '在微信小程序“我的 → 连接 App”中输入此连接码并确认。';
      });
      pollTimer = Timer.periodic(const Duration(seconds: 2), (_) => _poll());
    } catch (error) {
      if (!mounted) return;
      setState(() {
        starting = false;
        message = friendlyApiError(error);
      });
    }
  }

  Future<void> _poll() async {
    final current = link;
    if (!mounted || current == null || polling || starting) return;
    if (!DateTime.now().isBefore(current.expiresAt)) {
      pollTimer?.cancel();
      setState(() => message = '连接码已过期，请重新获取。');
      return;
    }
    polling = true;
    try {
      final result = await widget.services.auth!.exchangePendingLink();
      if (!mounted) return;
      if (result.state == 'approved') {
        widget.services.sessionInvalidated.value = false;
        pollTimer?.cancel();
        final profile = await widget.services.auth!.getCurrentUser();
        if (!mounted) return;
        context.go(
          profile.hasFamily && profile.family != null
              ? '/home'
              : '/family-choice',
        );
      } else if (result.state == 'expired') {
        pollTimer?.cancel();
        setState(() => message = '连接码已失效，请重新获取。');
      } else {
        setState(() => message = '等待小程序确认…');
      }
    } catch (error) {
      if (mounted) setState(() => message = friendlyApiError(error));
    } finally {
      polling = false;
    }
  }

  Future<void> _copyCode() async {
    final value = link?.code;
    if (value == null) return;
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('连接码已复制')));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('连接家庭药箱')),
    body: AppPage(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: ListView(
            shrinkWrap: true,
            children: [
              AppCard(
                color: const Color(0xFFE9F1EB),
                child: Column(
                  children: [
                    const Icon(Icons.medical_services_outlined, size: 40),
                    const SizedBox(height: 12),
                    Text(
                      '家庭药箱',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 6),
                    const Text('需要在已登录的小程序中确认，App 不会接触微信密码或 AppSecret。'),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '一次性连接码',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 16),
                    Center(
                      child: starting
                          ? const CircularProgressIndicator()
                          : Text(
                              link?.code ?? '------',
                              key: const ValueKey('device-link-code'),
                              style: const TextStyle(
                                fontSize: 38,
                                letterSpacing: 8,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                    ),
                    const SizedBox(height: 14),
                    if (link != null)
                      PrimaryButton(
                        label: '复制连接码',
                        icon: Icons.copy_rounded,
                        onPressed: _copyCode,
                      ),
                    const SizedBox(height: 14),
                    Text(message ?? '正在获取安全连接码…'),
                    if (link != null)
                      Text(
                        '有效至 ${_formatTime(link!.expiresAt)}，使用一次后立即失效。',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    const SizedBox(height: 10),
                    const Text('小程序：我的 → 连接 App → 输入连接码 → 核对家庭并确认'),
                    const SizedBox(height: 12),
                    SoftButton(
                      label: '重新获取连接码',
                      onPressed: starting ? null : _start,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  String _formatTime(DateTime value) {
    final local = value.toLocal();
    return '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
  }
}
