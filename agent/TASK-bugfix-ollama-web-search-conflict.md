# Bugfix: Ollama Pi web-search conflict

## Reported behavior

Running `ollama launch pi` installed `npm:@ollama/pi-web-search`. Pi then failed
at startup because both that package and the existing global `web-tools`
extension registered tools named `web_search` and `web_fetch`.

## Root cause

Pi requires extension tool names to be unique. The Ollama launcher added its web
package to `~/.pi/agent/settings.json`, while the manually installed extension at
`~/.pi/agent/extensions/web-tools/index.ts` was still auto-discovered. Both
extensions use the same two tool names, so Pi rejected the later registrations.

## Minimal fix

Keep the Ollama package installed and listed, but set its `extensions` filter to
an empty array in `~/.pi/agent/settings.json`. This prevents only its duplicate
extension from loading. The existing `web_search` and `web_fetch` tools remain
available, and the Ollama provider/model configuration remains unchanged.

## Verification

- PASS — `pi list` recognizes the Ollama package as filtered.
- PASS — A normal Pi RPC startup exits successfully without tool-conflict
  diagnostics and resolves the configured Ollama model.
- PASS — `ollama launch pi --model
  hf.co/fdtn-ai/Foundation-Sec-8B-Reasoning-Q8_0-GGUF:latest` reaches Pi without
  reinstalling the package or reporting duplicate tools.
