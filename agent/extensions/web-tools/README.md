# Pi Web Tools

Global, no-key web tools for Pi:

- `web_search` uses DuckDuckGo's no-key HTML results when available, then falls back through Yahoo, Bing HTML, and Bing RSS.
- `web_fetch` safely fetches public pages and extracts readable Markdown, using Jina Reader only as a fallback for blocked pages and PDFs.

No account, API key, or paid search service is required.

## Agent usage

Ask naturally, for example:

- “Search the web for the latest Node.js 24 release notes.”
- “Find the official documentation for this TypeScript error and explain it.”
- “Check whether this library has addressed issue X recently.”

The tools are active automatically. `web_search` supports optional domain and recency filters, and the agent can follow relevant results with `web_fetch`. Domain restrictions are enforced after parsing rather than trusted to each engine. Search results are confidence-scored; strong results return immediately, while weak results trigger another backend and are deduplicated and re-ranked. Results matching only generic query words are suppressed when subject-matching results exist. Parallel searches are serialized briefly to reduce bot challenges.

## Safety and limits

- Local, private, loopback, link-local, and other non-public network destinations are blocked.
- Redirects are revalidated and limited to five.
- Downloads are capped at 5MB.
- Tool output is capped at Pi's standard 50KB/2,000-line limit; full extracted text is saved to a temporary file when truncated.
- Web content is explicitly marked as untrusted data to reduce prompt-injection risk.
- A URL is sent to the free Jina Reader service only when direct extraction fails or the source is a PDF.
- Heavy HTML extraction dependencies are loaded lazily, so merely enabling the extension does not add their parsing cost to Pi startup.

These no-key HTML/RSS endpoints do not provide an API stability guarantee. The multi-engine fallback makes the tool more resilient, but future search-engine layout or access-policy changes may require an update.
