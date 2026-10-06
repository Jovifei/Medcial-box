# 本机药品条码资料库

2026-10-04，本机独立试用配置。当前服务为本机开发网关，不是正式公网身份服务。

## 查询路线

手机扫码 → 家庭药箱 API → 当前家庭基础药品资料 → 人工审核的本机商品库 → 返回候选，用户核对后保存。

条码存在时只做精确匹配；不同条码不回退为同名药。当前家庭候选仅查未删除、未归档记录，返回药名、品牌、厂家、规格、批准号和成分。库存、有效期、位置、私人说明和照片不进入候选。

两套独立试用使用不同身份，既有家庭资料不会合并。共同读取的商品资料库位于 `<LOCAL_ARTIFACT>/catalog.json`，初始内容为：

```json
{"version":1,"entries":[]}
```

当前尚未导入真实共享商品数据。已保存条码可在原家庭复用；新药未收录时提示拍照或手动核对，不调用外网供应商猜测资料。

## 添加人工审核商品资料

输入 JSON 结构仍为 version=1、entries 数组。每条必须包含 barcodeValue（8至14位数字字符串）、name、source、reviewed=true。可选字段为 brand、specification、manufacturer、approvalNumber、activeIngredients、sourceUpdatedAt。

只输入核对过的基础商品资料；工具拒绝未审核记录、重复条码及夹带家庭库存等额外字段。总量上限10000条/5MB。没有从家庭业务数据库自动收集并公开资料的任务。

先构建 API，然后导入：

```powershell
npm run build --workspace @home-medicine/api
node scripts/import-local-medicine-catalog.mjs --input "绝对路径\人工审核资料.json" --output "<LOCAL_ARTIFACT>/catalog.json"
```

导入按条码更新，采用锁、临时文件和原子替换；读取实时生效。目录已被 Git 忽略，商品数据不随源码上传。

## 启动本机试用

在项目根目录运行 `npm run dev:local-trials`。启动器复用现有 medbox-pg-test 数据库容器和已迁移的独立 QA 数据库，数据库凭据只进入进程环境；没有写到脚本、仓库或命令行。API 编译产物需先就绪。已运行的服务会跳过，不强行关闭其他进程。

App 服务13306，经USB反向转发13300；小程序13307。两者显式使用本机商品库和 qwen3.5:9b，保留独立试用身份。本机 Node 服务、PostgreSQL、Ollama 及 USB 转发需要在线。

## 其他人远程使用

资料库可保留在本机，但需要可访问的 HTTPS 服务入口、正式微信/设备鉴权及可用的主机网络路线。当前127.0.0.1服务与固定测试身份不能直接对外上线。这些资源与双账号/双手机验收尚未完成。
