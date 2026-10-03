# 多格式导出依赖登记

- pdf-lib 1.17.1：MIT，https://github.com/Hopding/pdf-lib ，用于生成PDF；未引入第三方药品资料库。
- @pdf-lib/fontkit 1.1.1：MIT，https://github.com/Hopding/fontkit ，用于嵌入中文字体。
- API中文字体复用Android的 MedBoxSansSC-Regular.ttf；OFL授权文件随 assets/fonts/NotoSansSC-OFL.txt 保存，Docker一并复制。
- npm精确版本与完整依赖由package-lock.json锁定；不将下载缓存和SDK提交项目。
