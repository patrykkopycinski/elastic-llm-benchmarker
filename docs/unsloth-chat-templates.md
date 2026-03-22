# Unsloth chat templates reference

When the model’s built-in chat template doesn’t feel right (e.g. tool calling fails or formatting is off), we use [Unsloth](https://unsloth.ai) as a reference for improved chat templates.

## Why Unsloth

Unsloth maintains a well-tested set of chat templates for many families (Llama, Qwen, Mistral, Gemma, Phi, etc.) and documents them in one place. Their Jinja definitions are useful when vLLM’s default or model-provided template isn’t reliable.

## Where we use it

- **vLLM params resolver** (`src/services/vllm-model-params.ts`) sets an optional `unslothTemplateKey` per model family (e.g. `llama-3.1`, `qwen-2.5`, `mistral`, `gemma-3`, `phi-4`). This key matches Unsloth’s `CHAT_TEMPLATES` in their repo.
- **Deploy logging**: when deploying a model that has an Unsloth-recommended key, we log it and the docs URL so you can cross-check or override the chat template if needed.

## Links

- **Docs:** [Unsloth – Chat templates](https://docs.unsloth.ai/basics/chat-templates)
- **Source:** [unsloth/chat_templates.py](https://github.com/unslothai/unsloth/blob/main/unsloth/chat_templates.py) — full list of `CHAT_TEMPLATES` keys and Jinja templates

## Overriding the chat template

To use a different template than the one we resolve (e.g. from Unsloth’s list), set `chatTemplate` in your deployment config so it overrides the default path we pass to vLLM’s `--chat-template`.
