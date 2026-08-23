import { describe, expect, it } from 'vitest';
import {
  looksLikeMarkdown,
  outputFormatInstruction,
  providerResponseFormat,
  validateOutputFormat,
} from '../src/outputFormat.js';
import { buildSystemPrompt } from '../src/prompt.js';

describe('output format mapping', () => {
  it('keeps JSON as a native provider format and maps markdown to text', () => {
    expect(providerResponseFormat('json')).toBe('json');
    expect(providerResponseFormat('text')).toBe('text');
    expect(providerResponseFormat('markdown')).toBe('text');
  });

  it('instructs markdown and JSON without pretending every provider has a native markdown mode', () => {
    expect(outputFormatInstruction('markdown')).toMatch(/GitHub-flavored Markdown/);
    expect(outputFormatInstruction('json')).toMatch(/JSON object/);
    expect(outputFormatInstruction('text')).toBeUndefined();
  });
});

describe('markdown detection', () => {
  it('accepts headings, lists, emphasis, links, and fences', () => {
    expect(looksLikeMarkdown('# Heading\n\nA paragraph.')).toBe(true);
    expect(looksLikeMarkdown('- one\n- two')).toBe(true);
    expect(looksLikeMarkdown('1. first')).toBe(true);
    expect(looksLikeMarkdown('See [docs](https://example.com).')).toBe(true);
    expect(looksLikeMarkdown('Use **bold** text.')).toBe(true);
    expect(looksLikeMarkdown('Use `code` spans.')).toBe(true);
    expect(looksLikeMarkdown('```ts\nconst x = 1;\n```')).toBe(true);
  });

  it('rejects empty or unstructured prose', () => {
    expect(looksLikeMarkdown('')).toBe(false);
    expect(looksLikeMarkdown('plain sentence with no structure')).toBe(false);
  });
});

describe('output format validation', () => {
  it('requires a JSON object, not an array or fragment', () => {
    expect(validateOutputFormat('json', '{"ok":true}')).toMatchObject({ passed: true });
    expect(validateOutputFormat('json', '[1]').passed).toBe(false);
    expect(validateOutputFormat('json', 'not json').passed).toBe(false);
    expect(validateOutputFormat('json', '').passed).toBe(false);
  });

  it('requires markdown structure and accepts ordinary text', () => {
    expect(validateOutputFormat('markdown', '# Done\n\n- shipped').passed).toBe(true);
    expect(validateOutputFormat('markdown', 'shipped').passed).toBe(false);
    expect(validateOutputFormat('text', 'shipped').passed).toBe(true);
  });
});

describe('system prompt carries the format', () => {
  it('appends the markdown instruction after skills', () => {
    const prompt = buildSystemPrompt({
      systemInstructions: 'You maintain the billing service.',
      projectRules: [],
      skills: ['docs/skills/refunds.md'],
      outputFormat: 'markdown',
    });
    expect(prompt.indexOf('You maintain the billing service.')).toBe(0);
    expect(prompt).toContain('Available skills');
    expect(prompt).toContain('GitHub-flavored Markdown');
    expect(prompt.indexOf('Available skills')).toBeLessThan(
      prompt.indexOf('GitHub-flavored Markdown'),
    );
  });

  it('does not add a format section for plain text', () => {
    const prompt = buildSystemPrompt({
      systemInstructions: 'You maintain the billing service.',
      projectRules: [],
      skills: [],
      outputFormat: 'text',
    });
    expect(prompt).toBe('You maintain the billing service.');
  });
});
