# Inline completion

English | [简体中文](completion.zh-CN.md)

[Back to README](../README.md)

Optionally configure a separate completion model for source-code editing, independently of Agent conversations.

[Configure a model](#configure-a-model) · [API formats](#api-formats) · [Behavior and tuning](#behavior-and-tuning)

## Configure a model

Inline completion is a separate backend from the agent profiles, so completion requests can use a model configured for low-latency suggestions while typing. Click the Dext status bar item, or run `Dext: Configure Completion Model`, and a short wizard asks for the API format, the base URL, the model ID, and the key, then offers to send one real request to check the whole thing works. The API key is never a setting: it is kept in VS Code's encrypted secret storage. Everything else lands in `dext.completion` in user settings, so a model configured once is available in every project.

## API formats

Four formats are supported, and the choice has to match what the endpoint actually serves:

- `openai` — sends `prompt` and `suffix` to an OpenAI-compatible `/completions` endpoint; requires a model and endpoint that support fill-in-the-middle completion.
- `openai-chat` — sends the code on either side of the cursor as a chat prompt to `/chat/completions`.
- `anthropic` — sends a chat-style completion request to `/messages`.
- `ollama` — calls a local Ollama server through `/api/generate`, using its fill-in-the-middle fields. No key needed.

Latency and completion quality depend on the model and endpoint. Dext strips code fences from chat responses. A format mismatch can produce an HTTP 200 response with no usable completion text; Dext reports recognized mismatches during connection tests and completion requests.

## Behavior and tuning

Completion is off until an endpoint and a model are both configured. New requests are debounced; an in-flight generation can be reused when subsequent typing matches it. Context is a prefix and suffix window measured in characters rather than lines, so one long generated line cannot exhaust the budget.

How long a suggestion takes to appear is mostly a question of how much work happens between the keystroke and the first thing worth showing, so several things keep that down.

The reply is streamed, and the request is abandoned as soon as the completion is decidably finished rather than when the model reaches its token budget. Where extra lines could not be used anyway — the cursor is mid-line, or inside a comment — the model is told to stop at the newline, which usually means a handful of tokens instead of a block.

A generation also outlives the keystroke that started it. The editor cancels the previous request every time a character is typed, and following that would mean throwing away a nearly finished answer and starting from nothing several times a second; instead the request keeps running and the next keystroke waits on the same answer, minus the characters typed since. It is only abandoned once what was typed has diverged from what it was writing. For the same reason there is nothing to debounce while a generation is already in flight, so those keystrokes skip the debounce entirely. Once an answer has arrived the cache continues the job: typing the beginning of what was suggested serves the rest of that same suggestion from memory.

The prefix window is quantised and snapped to a line boundary to keep prompt prefixes stable between nearby keystrokes. This can improve reuse on backends that support prompt caching.

Providers meter this kind of backend by requests per second, and one that allows four of them refuses the fifth rather than queueing it. No setting can predict that limit, so Dext learns it: requests go out as fast as they are asked for until one is refused with HTTP 429, and are then spaced out by an interval that doubles while refusals continue and relaxes once they stop. A `Retry-After` is believed over that guess. This happens on its own, so `dext.completion.debounceMs` only needs raising if the backend is metered tightly enough that even the first refusal is worth avoiding.

If suggestions come out truncated, raise `dext.completion.maxTokens`; it is the main thing trading latency against length. Files excluded by `.gitignore` are skipped, and a `.dextignore` in the workspace root adds to those rules — read last, so it can also re-include a path `.gitignore` excluded. `.dx` files are left to the typed API completion provider. The status bar item turns completion off for the current window without editing settings, which is what makes it easy to live alongside another completion extension.
