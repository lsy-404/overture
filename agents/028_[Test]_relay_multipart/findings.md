# 发现

- [现象] Waline 首次 Worker 上传在浏览器经 relay 失败，但先前实时验收成功。 -> [检查] 阅读实时验收与 relay 测试。 -> [结论] 实时验收将相对 `/cf` 请求直接重定向至 Cloudflare API，且直接调用 capability host；现有 relay 测试没有 multipart 请求体覆盖。
- [现象] 首次创建用 `PUT /accounts/{id}/workers/scripts/{script}`，更新用 `POST .../versions`。 -> [检查] 比对部署实现和 allowlist。 -> [结论] 两个方法与路径均在 allowlist 内，需用完整请求测试 body/header 保真和错误封装。
- [现象] 需验证 relay 是否重建 multipart 请求时丢失边界或字节。 -> [尝试方案] 以真实 `FormData` 建立请求，经完整 Worker app、CSRF gate、auto session 和 `cfProxy`，并截获上游 fetch。 -> [结论] PUT 与 POST 均保留 path、method、session Authorization、`Content-Type` boundary 和 body bytes；403 上游响应变为 HTTP 200 并保留原状态与 JSON envelope。
