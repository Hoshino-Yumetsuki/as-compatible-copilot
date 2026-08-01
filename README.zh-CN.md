<div align="center">

<img src="icon.png" alt="AS Compatible Copilot Logo" width="120" height="120">

# AS Provider for Copilot

**在 VS Code 的 GitHub Copilot Chat 中使用 Anthropic、Google Gemini、OpenAI 及任意兼容接口**

</div>

[![License](https://img.shields.io/github/license/Hoshino-Yumetsuki/as-compatible-copilot?color=orange&label=License)](https://github.com/Hoshino-Yumetsuki/as-compatible-copilot/blob/main/LICENSE)

[English](README.md) | 简体中文

## 特性

- **多 Provider 支持**：Anthropic Messages、Google Gemini、OpenAI Responses、OpenAI-compatible Chat Completions（兼容 DeepSeek、SiliconFlow 等）
- **模型自动发现**：通过 Provider 的模型列表接口自动列举可用模型，无需手动填写每个模型 ID
- **推理强度控制**：支持 `low / medium / high / xhigh / max` 五档 Reasoning Effort，适配 Anthropic 和 OpenAI 推理模型
- **图片输入**：对支持视觉能力的模型启用图片上下文
- **工具调用**：对支持 Tool Calling 的模型启用 Agent 工具调用能力
- **可视化配置界面**：通过内置界面或指令管理 Provider Profile、模型和全局设置，无需手动编辑任何文件

## 环境要求

- VS Code `>= 1.126.0`
- GitHub Copilot 扩展（需启用 `chatProvider` 和 `languageModelSystem` 提案 API）

## 快速开始

1. 在 [VS Code 扩展市场](https://marketplace.visualstudio.com/items?itemName=Q78KG.as-compatible-copilot) 安装 **AS Provider for Copilot**。
2. 按 `Ctrl+Shift+P`，执行 **AS Provider for Copilot: Open Configuration**。
3. 在配置界面添加一个 Provider Profile，选择 Provider 类型并填写 Base URL。
4. 为该 Profile 填写 API Key。
5. 完成后，模型将自动出现在 Copilot 的模型选择器中。

## 可视化配置界面

本扩展提供可视化配置界面，方便管理 Provider Profile、模型和全局设置，无需手动编辑任何文件。

### 打开配置界面

按 `Ctrl+Shift+P`，搜索并执行 **AS Provider for Copilot: Open Configuration**。

<details>
<summary>点击展开：工作流示例</summary>

1. **添加 Provider Profile**
   - 在配置页面点击添加 Profile
   - 选择 Provider 类型（如 `openai-compatible`）
   - 填写 Base URL（如 `https://api.deepseek.com/v1`）
   - 填写 API Key
   - 保存后扩展将自动发现该 Provider 下的所有模型

2. **手动添加模型**
   - 若 Provider 不支持模型列表接口，可手动添加模型配置
   - 填写模型 ID、关联 Profile，并按需配置上下文长度、工具调用、图片输入等能力

3. **在 Copilot 中使用**
   - 打开 GitHub Copilot Chat（`Ctrl+Shift+I`）
   - 点击模型选择器，选择 "Manage Models..."
   - 选择 **AS Provider for Copilot** 供应商
   - 选择已发现或手动配置的模型，开始对话

</details>

## 多 Provider 管理

每个 Provider Profile 对应一个独立的上游 API 服务，可同时配置多个 Profile 并为每个 Profile 单独管理 API Key。

| Provider 类型 | 默认 Base URL | 说明 |
|---|---|---|
| `anthropic` | `https://api.anthropic.com` | Anthropic Claude 系列 |
| `google` | `https://generativelanguage.googleapis.com` | Google Gemini 系列 |
| `openai-responses` | `https://api.openai.com/v1` | OpenAI Responses API |
| `openai-compatible` | 用户自定义 | 任意 OpenAI 兼容接口 |

## 推理强度控制

对于支持推理功能的模型（如 Claude、GPT 等），可在全局设置中配置推理强度，也可通过模型覆盖（Model Overrides）为特定模型单独设置：

| 档位 | 说明 |
|---|---|
| `low` | 最低推理消耗，速度最快 |
| `medium` | 均衡（默认） |
| `high` | 较高推理深度 |
| `xhigh` | 深度推理 |
| `max` | 最大推理消耗 |

此外，还可通过模型覆盖为特定模型单独覆盖 `contextLength`、`toolCalling`、`imageInput` 参数，而不影响全局设置。

## 命令

| 命令 | 说明 |
|---|---|
| `AS Provider for Copilot: Open Configuration` | 打开图形化配置页面 |
| `AS Provider for Copilot: Set API Key` | 为模型或 Profile 设置 API Key |
| `AS Provider for Copilot: Delete Configured Entry` | 删除已配置的模型或 Profile |
| `AS Provider for Copilot: Refresh Discovered Models` | 强制刷新自动发现的模型列表 |

## 开发

<details>
<summary>点击展开</summary>

### 环境要求

- Node.js 最新 LTS
- Yarn 4.x

### 常用脚本

```bash
# 安装依赖
yarn install

# 完整构建（清理 + WebView + 扩展主体）
yarn build

# 运行测试
yarn test

# 代码检查
yarn lint

# 打包 .vsix
yarn build:vsce
```

### 项目结构

```
src/
  core.ts          # 类型定义、Provider 选项、消息转换
  discovery.ts     # 模型自动发现
  extension.ts     # VS Code 扩展入口
  storage.ts       # 配置持久化
  views/
    configView.ts  # WebView 控制器
webview/           # 配置界面前端（Vue 3）
static/            # 构建后的 WebView 静态资源
```

</details>

## 致谢

- [Vercel AI SDK](https://sdk.vercel.ai/) — 底层多 Provider 推理驱动
- [VS Code Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)

## 支持 & 许可证

- 提交 Issue：https://github.com/Hoshino-Yumetsuki/as-compatible-copilot/issues
- 许可证：[MIT](LICENSE)
