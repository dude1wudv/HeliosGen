# HeliosGen 主站子路径迁移

正式入口为 `https://patrickapi.microedulab.com/cancas/`，编辑页为 `/cancas/workflow`。`/image2/` 由原服务提供，不属于此应用。

## 构建与配置

- 托管镜像构建参数及运行变量均设 `NEXT_PUBLIC_APP_BASE_PATH=/cancas`；该值会进入客户端构建，不能只改容器环境变量。
- `HELIOS_PUBLIC_ORIGIN=https://patrickapi.microedulab.com`，只含 origin。Sub2API 的 `helios_workbench.public_url` 为主站 `/cancas`，`redirect_uri` 为主站 `/cancas/bootstrap`。
- 本地、桌面构建不设路径前缀；桌面构建显式使用空前缀。Next Link/router 接收逻辑路径；原生 URL、fetch、SSE、图片通过 `appPaths`。
- 新托管 Cookie 为 `__Secure-helios_session`，host-only、Secure、HttpOnly、SameSite=Lax、Path=/cancas；读写清除共用配置。不会把旧 `__Host-helios_session` 当成新路径的会话。
- 保持原 `HELIOS_SESSION_SECRET`、媒体目录、数据库及 `.job-store.json`，只运行一个数据写入实例。镜像回退不代表数据回滚。

## 反向代理

新主站对 `/cancas` 及其子路径保留前缀代理至 HeliosGen；不能用剥前缀的 `handle_path`。根 `/api/v1`、`/v1`、`/image2/` 继续交给原服务。健康检查为 `/cancas/api/health`。

旧域必须在同一 origin 提供独立静态文件 `public/legacy-recovery.html`（可将旧页面路径内部代理到新应用 `/cancas/legacy-recovery.html`）。恢复页不运行应用 store 或同步 hook，只读取 `localStorage["heliosgen"]` 中的工作流与活动草稿；不会读取 Cookie、枚举浏览器存储或上传数据。

- 旧 `/bootstrap` 返回无缓存跳转至 `https://patrickapi.microedulab.com/helios#`，显式空 fragment 防止浏览器继承旧 code；由主站重新签发，不向新 bootstrap 转发旧 code。
- 旧 `GET/HEAD /api/media/<id>`、`POST /api/callback` 可窄代理至新前缀对应路径，保留 query，不作 HTTP 跳转。删除转发的 Cookie 和 Authorization，让媒体继续使用签名身份；现有签名、owner 和 pending-job 校验仍执行。
- 不泛代理旧会话 API，不向外暴露数据目录；其他旧 API 路径返回 404。旧页面路径显示恢复页，不能在用户导出前强制跳走。
- 新链接立即使用新域；保留旧域恢复和签名兼容路由，直至运营明确结束恢复窗口、在途任务已排空。不要根据一次健康检查删除旧兼容路由。

## 工作流与媒体恢复

旧页导出的 JSON 仅包含工作流及清单 hash，不包含媒体二进制，也不包含账户或会话凭据。新 `/cancas/recover` 支持导入 JSON 和完整工作流 ZIP；导入总是创建新 ID、副本名称，保留原文件与现有工作流，媒体继续检查当前用户归属。迁域后必须重新通过主站 bootstrap 登录。

历史 `/api/media/<id>` 与新 `/cancas/api/media/<id>` 在读取边界兼容，不批量改存储。完整 ZIP 导出识别两种路径，UI 必须报告未打包的媒体；只有 `skipped=0` 才能视为媒体完整。ZIP 导入若有媒体失败，不创建部分工作流，允许保留原文件后重试。

## 验收与回退

运行 `pnpm test`、`pnpm run lint:critical`、`pnpm exec tsc --noEmit`，并以 `/cancas` 实际构建和启动。浏览器检查 bootstrap 清 fragment、深链接刷新、公共资源、工作流编辑、上传、媒体缩略图、下载、SSE、登出及恢复副本；Network 中应用自有请求应位于 `/cancas/`。消费型调用使用 mock。

发布前备份保留在服务器：原镜像、容器配置、发布配置、Caddy、应用数据和一致性数据库备份。新镜像可先在隔离本机端口校验健康，正式共享数据只运行一个写入实例；Caddy 先 validate 再 reload。回退恢复同一轮备份的应用镜像与路由/回调配置，保留原数据和兼容入口，不删除卷、不自动回滚数据库。
