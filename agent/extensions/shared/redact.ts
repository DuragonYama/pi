/** Redact common credential forms before metadata reaches disk or a ping. */
export function redactSecrets(text: string): string {
	return text
		.replace(/([?&](?:token|key|secret|password|auth|api[_-]?key|sig|signature)=)[^&\s"']*/gi, "$1REDACTED")
		.replace(/(https?:\/\/[^\s/@]+):[^\s/@]*@/gi, "$1:REDACTED@")
		.replace(/((?:authorization|api[_-]?key|x-[a-z-]*key|token)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"']+(?:\s+[^\s"']+)?/gi, "$1REDACTED")
		.replace(/(--(?:password|passwd|token|secret|api[_-]?key)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1REDACTED")
		.replace(/(\s-p\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1REDACTED")
		.replace(/((?:api[_-]?key|token|secret|password)=)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1REDACTED");
}
