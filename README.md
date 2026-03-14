# ClawRouter

Smart LLM router for [OpenClaw](https://openclaw.ai) — use your own API keys with intelligent cost-based model routing.

## What It Does

ClawRouter classifies every LLM request into a complexity tier (SIMPLE / MEDIUM / COMPLEX / REASONING) using a 15-dimension weighted scorer, then routes it to the cheapest capable model. Routing is 100% local (<1ms), no external API calls.

**Gemini-first routing** — Google Gemini models are used for all tiers. Anthropic is only used as a last-resort fallback when Gemini hits rate limits or quotas.

| Tier      | Primary Model              | Price (in/out per 1M) |
| --------- | -------------------------- | --------------------- |
| SIMPLE    | gemini-2.5-flash-lite      | $0.10 / $0.40         |
| MEDIUM    | gemini-2.5-flash           | $0.30 / $2.50         |
| COMPLEX   | gemini-3.1-pro             | $2.00 / $12.00        |
| REASONING | gemini-2.5-pro             | $1.25 / $10.00        |

## Quick Start

```bash
# Install as OpenClaw plugin
cd ClawRouter
npm install && npm run build
openclaw plugins install -l .
openclaw gateway restart
```

### Configure API Keys

Set your API keys via environment variables or in `~/.openclaw/openclaw.json`:

```bash
# Environment variables (in your shell profile or systemd override)
export GEMINI_API_KEY="AIza..."        # or GOOGLE_API_KEY
export ANTHROPIC_API_KEY="sk-ant-..."  # optional fallback
```

Or configure in the plugin config:

```json
{
  "plugins": {
    "entries": {
      "clawrouter": {
        "enabled": true,
        "config": {
          "providers": {
            "google": { "apiKey": "AIza..." },
            "anthropic": { "apiKey": "sk-ant-..." }
          }
        }
      }
    }
  }
}
```

### Set as Default Model

```bash
openclaw models set clawrouter/auto
```

## Routing Profiles

| Profile          | Strategy           | Best For         |
| ---------------- | ------------------ | ---------------- |
| `clawrouter/auto`    | Balanced (default) | General use      |
| `clawrouter/eco`     | Cheapest possible  | Maximum savings  |
| `clawrouter/premium` | Best quality       | Complex tasks    |

## How Routing Works

```
Request → 15-dimension scorer → Complexity tier → Cheapest capable model → Provider API
```

The scorer analyzes: token count, code presence, reasoning markers, technical terms, creative markers, simple indicators, multi-step patterns, question complexity, imperative verbs, constraints, output format, references, negation, domain specificity, and agentic task indicators.

When the primary model fails (rate limit, quota, error), ClawRouter automatically falls through the fallback chain — trying other Gemini models first, then Anthropic as a last resort.

## Custom Tier Configuration

Override the default routing in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "clawrouter": {
        "config": {
          "routing": {
            "tiers": {
              "SIMPLE": {
                "primary": "google/gemini-2.5-flash-lite",
                "fallback": ["google/gemini-2.5-flash"]
              },
              "COMPLEX": {
                "primary": "google/gemini-3.1-pro",
                "fallback": ["google/gemini-2.5-pro", "anthropic/claude-sonnet-4.6"]
              }
            }
          }
        }
      }
    }
  }
}
```

## Commands

| Command        | Description                     |
| -------------- | ------------------------------- |
| `/stats [days]`| Show usage statistics           |
| `/stats clear` | Reset usage data                |
| `/keys`        | Show configured API key status  |

## Supported Providers

| Provider   | Env Variable(s)                        |
| ---------- | -------------------------------------- |
| Google     | `GOOGLE_API_KEY` or `GEMINI_API_KEY`   |
| Anthropic  | `ANTHROPIC_API_KEY`                    |
| OpenAI     | `OPENAI_API_KEY`                       |
| DeepSeek   | `DEEPSEEK_API_KEY`                     |
| xAI        | `XAI_API_KEY`                          |
| Moonshot   | `MOONSHOT_API_KEY`                     |
| OpenRouter | `OPENROUTER_API_KEY` (covers all)      |

## Development

```bash
git clone https://github.com/aitrace-dev/ClawRouter.git
cd ClawRouter
npm install
npm run build
npm test
```

## Configuration

| Variable              | Default | Description           |
| --------------------- | ------- | --------------------- |
| `BLOCKRUN_PROXY_PORT` | `8402`  | Local proxy port      |
| `CLAWROUTER_DISABLED` | `false` | Disable smart routing |

## License

MIT
