# 调研

- 正式实例 /policy 返回 oauthEnabled=false，允许列表只有 EdgeSonic/OMEW；用户本次明确要求使用正式实例，更新来源许可。
- origin/main=7a59deb；本地 main 存在其他未推送提交，必须仅推送从远端 main 派生的本次提交。
- 现有条款错误声称所有 API 令牌都会写入目标 Worker，未准确说明浏览器输入、会话 cookie 与应用凭证声明；按实际实现重写。
- Wrangler OAuth 不含 OAuth Client 管理权限，查询正式账户 OAuth clients HTTP403。
- 参考 Cloudflare 官方 workers.dev 配置和 OAuth client 创建文档核对基础设施行为；条款文本为本服务原写，不照搬第三方协议。
