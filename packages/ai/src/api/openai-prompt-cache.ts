export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
export function clampOpenAIPromptCacheKey(value: string | undefined): string | undefined {
	return value === undefined ? undefined : [...value].slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
