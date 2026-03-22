# Why Llama 3.3 70B Can Fail Tool Calling

## 1. Missing `--chat-template` (fixable)

vLLM requires a **tool-calling chat template** for Llama models when using `--tool-call-parser llama3_json`. Without it, the model may:

- Output tool calls in a format that doesn’t map to `choices[0].message.tool_calls`
- Or respond with plain text instead of structured tool calls

**vLLM docs:** use `--chat-template examples/tool_chat_template_llama3.1_json.jinja` (or the 3.2 / 3.3 variant if available) for Llama 3.x tool calling.

Our deployment was only passing `--tool-call-parser llama3_json` and `--enable-auto-tool-choice`, and **not** `--chat-template`, so the server could be using the default chat template, which is not the tool-use one. That likely led to empty or wrong `tool_calls` in the API response and our benchmark seeing 0 tool calls.

**Fix:** The deployment now adds `--chat-template examples/tool_chat_template_llama3.1_json.jinja` for Llama when tool calling is enabled (3.1 template works for 3.2/3.3 and is present in vLLM v0.15.1 images). You can override via config `chatTemplate` if your image has a 3.3-specific template.

---

## 2. Parallel tool calls not supported for Llama 3 (limitation)

vLLM explicitly states:

> **Parallel tool calls are not supported for Llama 3, but it is supported in Llama 4 models.**

So for Llama 3.1 / 3.2 / 3.3:

- **Sequential (single tool call per turn)** can work once the chat template is set.
- **Parallel (multiple tool calls in one response)** is not supported; scenarios that request 2, 3, 4, or 5 calls in one go will not succeed.

Our benchmark runs both:

- One **sequential** scenario: 1 tool call per response.
- Several **parallel** scenarios: 2–5 tool calls in one response.

So even with the correct chat template, Llama 3.x will:

- Pass the single-call (sequential) scenario.
- Fail the multi-call (parallel) scenarios, so `supportsParallelCalls` will be false and the overall benchmark may still be reported as failed if we require 100% parallel success.

---

## 3. Summary

| Cause                         | Fix / expectation                                                                 |
|------------------------------|-------------------------------------------------------------------------------------|
| No `--chat-template`         | Add `--chat-template examples/tool_chat_template_llama3.1_json.jinja` for Llama.   |
| Llama 3 has no parallel TCs | Expect only sequential tool calls; parallel scenarios will fail for Llama 3.x.    |

After adding the chat template, Llama 3.3 70B should at least pass **sequential** tool calling; **parallel** will remain unsupported until using a model/parser that supports it (e.g. Llama 4).
