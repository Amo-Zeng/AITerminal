# 模型 API 配置 / Model API configuration

在连接配置的 AI 页面填写 API 地址、模型名称、Key 和 **API 格式**。配置按标签保存；配置方案会保留格式，但不会明文保存 Key。切换地址时不沿用原地址的 Key；请填写新 Key 或使用该地址已保存的凭据。模型名称须使用服务商实际支持的名称，可选择“自定义”。

| 格式 / Format | 完整接口示例 / Endpoint | 认证 / Authentication |
| --- | --- | --- |
| OpenAI Chat Completions | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer …` |
| OpenAI Responses | `https://api.openai.com/v1/responses` | `Authorization: Bearer …` |
| Anthropic Messages | `https://api.anthropic.com/v1/messages` | `x-api-key`、`anthropic-version: 2023-06-01` |

基础地址（例如 `https://api.openai.com`）、版本前缀（`https://example.com/proxy/v1`）和完整接口地址都可以使用。选择格式后会补全接口路径；已有完整接口不会重复拼接。代理前缀和 URL 查询参数保留。请勿把 Key 放在 URL 中。

“自动”从 URL 末尾的 `/responses`、`/messages`、`/chat/completions` 识别格式；只有基础地址时默认 Chat Completions，兼容旧配置。使用 `https://api.anthropic.com` 等基础地址时须主动选择 Messages。应用不会根据模型名称猜测协议，也不会替换用户填写的服务地址。

三种格式均支持普通 JSON 回复、SSE 流式文本和接管模式的原生插件工具调用。Responses 使用 `input`、`max_output_tokens` 与 `function_call_output`，并在工具往返中保留推理项目；请求明确设置 `store: false`。Messages 使用顶层 `system`、内容块、`input_schema` 与 `tool_result`，保留工具调用前的 thinking/signature。Messages 的 temperature 限制为 0–1（高于 1 的配置按 1 发送）；其他格式使用 0–2。

Responses 只有收到 `response.completed`、Messages 只有收到 `message_stop` 且内容完整才会执行工具；错误、截断、未知工具、取消请求都不会执行其中的命令。每个请求最多 8 轮工具交互、每轮最多 16 个工具。Chat Completions 保留对旧兼容服务的文本工具回退；其他格式不会在 400/422 后悄悄换协议。

此适配覆盖文本对话和应用声明的 function tools，不启用服务商的网页搜索、计算机操作、图片/音频等内置工具。个别模型可能不接受 temperature 或有不同的 Token 最小值，服务商兼容程度也可能不同；请用“测试 AI 连接”确认自己的地址和模型。HTTP 只允许本机 loopback，其他地址必须为 HTTPS。

## English

Choose **API format** in the AI settings, then enter your provider's URL, model name and key. Formats are saved with each tab/profile; keys stay in the protected credential store. Use a custom model name when needed.

The table above lists the three wire formats and their authentication headers. URLs can be an origin, a versioned proxy prefix or a full endpoint. Auto mode infers the format from a full endpoint and otherwise defaults to Chat Completions. For an Anthropic base URL, select Messages explicitly. Switching format replaces an existing endpoint suffix while preserving the proxy prefix and query parameters.

All three formats support JSON, SSE text streaming and native plugin tool calls during takeover. Responses sends `store: false` and preserves reasoning output during tool continuation. Messages preserves thinking/signature blocks and sends correlated `tool_result` blocks. Incomplete streams cannot execute tools. Requests retain per-tab cancellation, bounded retries, deadlines and response-size limits. Provider-specific built-in tools and multimodal input are outside this adapter's scope.

## 协议依据与验证 / References and verification

- [OpenAI Responses](https://developers.openai.com/api/docs/api-reference/responses) · [官方 TypeScript 协议定义](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages) · [官方协议定义](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts) · [官方流式实现](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/MessageStream.ts)

`test/aiProtocols.test.js` 使用本机 HTTP fixture 核验真实请求、认证头、UTF-8 分块、两个工具的结果关联、推理块保留、错误与取消；不使用真实 Key，也不产生模型费用。`npm run smoke:config-modal` 验证配置保存、加载及连接测试的格式传递。尚未用付费服务账号对每个服务商进行在线调用验证。
