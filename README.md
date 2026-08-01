<div align="center">

<img src="icon.png" alt="AS Compatible Copilot Logo" width="120" height="120">

# AS Provider for Copilot

**Use Anthropic, Google Gemini, OpenAI, and any compatible API in VS Code's GitHub Copilot Chat**

</div>

[![License](https://img.shields.io/github/license/Hoshino-Yumetsuki/as-compatible-copilot?color=orange&label=License)](https://github.com/Hoshino-Yumetsuki/as-compatible-copilot/blob/main/LICENSE)

English | [简体中文](README.zh-CN.md)

## Features

- **Multi-Provider Support**: Anthropic Messages, Google Gemini, OpenAI Responses, and OpenAI-compatible Chat Completions (compatible with DeepSeek, SiliconFlow, etc.)
- **Automatic Model Discovery**: Automatically enumerates available models via the provider's model list API — no need to manually enter every model ID
- **Reasoning Effort Control**: Supports five levels — `low / medium / high / xhigh / max` — for Anthropic and OpenAI reasoning models
- **Image Input**: Enables image context for models with vision capabilities
- **Tool Calling**: Enables agent tool-calling for models that support it
- **Visual Configuration UI**: Manage Provider Profiles, models, and global settings through a built-in interface or commands — no manual file editing required

## Requirements

- VS Code `>= 1.126.0`
- GitHub Copilot extension (with `chatProvider` and `languageModelSystem` proposed APIs enabled)

## Quick Start

1. Install **AS Provider for Copilot** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Q78KG.as-compatible-copilot).
2. Press `Ctrl+Shift+P` and run **AS Provider for Copilot: Open Configuration**.
3. Add a Provider Profile, select the provider type, and enter the Base URL.
4. Enter the API Key for that profile.
5. Models will automatically appear in Copilot's model picker.

## Visual Configuration UI

The extension provides a visual configuration interface to manage Provider Profiles, models, and global settings without editing any files manually.

### Open the Configuration UI

Press `Ctrl+Shift+P`, search for and run **AS Provider for Copilot: Open Configuration**.

<details>
<summary>Click to expand: Workflow example</summary>

1. **Add a Provider Profile**
   - Click "Add Profile" on the configuration page
   - Select the provider type (e.g. `openai-compatible`)
   - Enter the Base URL (e.g. `https://api.deepseek.com/v1`)
   - Enter the API Key
   - After saving, the extension will automatically discover all models for that provider

2. **Add a Model Manually**
   - If the provider doesn't support a model list API, you can add model configurations manually
   - Enter the model ID, associate it with a profile, and configure context length, tool calling, image input, etc. as needed

3. **Use in Copilot**
   - Open GitHub Copilot Chat (`Ctrl+Shift+I`)
   - Click the model picker and select "Manage Models..."
   - Choose the **AS Provider for Copilot** vendor
   - Select a discovered or manually configured model and start chatting

</details>

## Multi-Provider Management

Each Provider Profile corresponds to a separate upstream API service. You can configure multiple profiles simultaneously and manage API Keys independently for each.

| Provider Type | Default Base URL | Description |
|---|---|---|
| `anthropic` | `https://api.anthropic.com` | Anthropic Claude series |
| `google` | `https://generativelanguage.googleapis.com` | Google Gemini series |
| `openai-responses` | `https://api.openai.com/v1` | OpenAI Responses API |
| `openai-compatible` | User-defined | Any OpenAI-compatible endpoint |

## Reasoning Effort Control

For models that support reasoning (e.g. Claude, GPT), you can configure the reasoning effort level globally or override it per model using Model Overrides:

| Level | Description |
|---|---|
| `low` | Minimum reasoning, fastest |
| `medium` | Balanced (default) |
| `high` | Higher reasoning depth |
| `xhigh` | Deep reasoning |
| `max` | Maximum reasoning effort |

You can also use Model Overrides to set `contextLength`, `toolCalling`, and `imageInput` per model without affecting global settings.

## Commands

| Command | Description |
|---|---|
| `AS Provider for Copilot: Open Configuration` | Open the graphical configuration page |
| `AS Provider for Copilot: Set API Key` | Set an API Key for a model or profile |
| `AS Provider for Copilot: Delete Configured Entry` | Delete a configured model or profile |
| `AS Provider for Copilot: Refresh Discovered Models` | Force-refresh the auto-discovered model list |

## Development

<details>
<summary>Click to expand</summary>

### Requirements

- Node.js latest LTS
- Yarn 4.x

### Common Scripts

```bash
# Install dependencies
yarn install

# Full build (clean + WebView + extension)
yarn build

# Run tests
yarn test

# Lint
yarn lint

# Package .vsix
yarn build:vsce
```

### Project Structure

```
src/
  core.ts          # Type definitions, provider options, message conversion
  discovery.ts     # Automatic model discovery
  extension.ts     # VS Code extension entry point
  storage.ts       # Configuration persistence
  views/
    configView.ts  # WebView controller
webview/           # Configuration UI frontend (Vue 3)
static/            # Built WebView static assets
```

</details>

## Acknowledgements

- [Vercel AI SDK](https://sdk.vercel.ai/) — Underlying multi-provider inference driver
- [VS Code Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)

## Support & License

- Submit an Issue: https://github.com/Hoshino-Yumetsuki/as-compatible-copilot/issues
- License: [MIT](LICENSE)
