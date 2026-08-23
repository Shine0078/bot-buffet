import type { AgentProfile } from './types.js';

export type OutputFormat = AgentProfile['outputFormat'];
export type ProviderResponseFormat = 'text' | 'json';

const MARKDOWN_INSTRUCTION =
  'Respond in GitHub-flavored Markdown. Use headings, lists, and fenced code blocks where they help a human operator. Do not wrap the entire reply in a single code fence.';

const JSON_INSTRUCTION = 'Respond with a single JSON object and no surrounding Markdown or prose.';

export function providerResponseFormat(format: OutputFormat): ProviderResponseFormat {
  return format === 'json' ? 'json' : 'text';
}

export function outputFormatInstruction(format: OutputFormat): string | undefined {
  if (format === 'markdown') return MARKDOWN_INSTRUCTION;
  if (format === 'json') return JSON_INSTRUCTION;
  return undefined;
}

export function looksLikeMarkdown(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (/^#{1,6}\s+\S/m.test(text)) return true;
  if (/^\s*[-*+]\s+\S/m.test(text)) return true;
  if (/^\s*\d+\.\s+\S/m.test(text)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return true;
  if (/(\*\*|__)\S[\s\S]*?\1/.test(text)) return true;
  if (/`[^`]+`/.test(text)) return true;
  if (/^```/m.test(text)) return true;
  return false;
}

export function validateOutputFormat(
  format: OutputFormat,
  content: string,
): { passed: boolean; detail: string } {
  const text = content.trim();
  if (!text) {
    return { passed: false, detail: `${format} output was empty.` };
  }
  if (format === 'json') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { passed: false, detail: 'JSON output must be an object.' };
      }
      return { passed: true, detail: 'JSON object parsed.' };
    } catch {
      return { passed: false, detail: 'JSON output did not parse.' };
    }
  }
  if (format === 'markdown') {
    if (looksLikeMarkdown(text)) {
      return { passed: true, detail: 'Markdown structure present.' };
    }
    return {
      passed: false,
      detail: 'Markdown output had no headings, lists, emphasis, links, or fenced code.',
    };
  }
  return { passed: true, detail: 'Plain text accepted.' };
}
