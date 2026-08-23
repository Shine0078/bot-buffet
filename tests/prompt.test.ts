import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/prompt.js';

describe('system prompt assembly', () => {
  const profile = (overrides: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}) => ({
    systemInstructions: 'You maintain the billing service.',
    projectRules: [],
    skills: [],
    ...overrides,
  });

  it('carries the instructions through unchanged', () => {
    expect(buildSystemPrompt(profile())).toBe('You maintain the billing service.');
  });

  it('includes a profile description after the instructions', () => {
    const prompt = buildSystemPrompt(profile({ description: 'Local billing operator' }));
    expect(prompt).toContain('Agent description: Local billing operator');
    expect(prompt.indexOf('You maintain the billing service.')).toBeLessThan(
      prompt.indexOf('Agent description'),
    );
  });
  it('lists project rules as rules rather than running them together', () => {
    const prompt = buildSystemPrompt(
      profile({ projectRules: ['Never touch migrations', 'Prefer small commits'] }),
    );
    expect(prompt).toContain('- Never touch migrations');
    expect(prompt).toContain('- Prefer small commits');
  });

  it('lists skills by name only, which is the point of progressive disclosure', () => {
    // `skills` was declared on every profile and used nowhere, so an agent
    // never learned its own skills existed. Names only, so the full text does
    // not occupy the context budget on every step.
    const prompt = buildSystemPrompt(
      profile({ skills: ['docs/skills/refunds.md', 'docs/skills/dunning.md'] }),
    );
    expect(prompt).toContain('Available skills');
    expect(prompt).toContain('- docs/skills/refunds.md');
    expect(prompt).toContain('- docs/skills/dunning.md');
  });

  it('omits empty sections instead of emitting bare headings', () => {
    const prompt = buildSystemPrompt(profile());
    expect(prompt).not.toContain('Project rules');
    expect(prompt).not.toContain('Available skills');
  });

  it('keeps instructions first so a skill list cannot displace them', () => {
    const prompt = buildSystemPrompt(profile({ projectRules: ['rule'], skills: ['skill'] }));
    expect(prompt.indexOf('You maintain the billing service.')).toBe(0);
    expect(prompt.indexOf('Project rules')).toBeLessThan(prompt.indexOf('Available skills'));
  });

  it('includes the latest changelog entry after skills', () => {
    const prompt = buildSystemPrompt(
      profile({ skills: ['skill'], changelog: ['Initial profile', 'Raised step limit'] }),
    );
    expect(prompt).toContain('Latest profile change: Raised step limit');
    expect(prompt.indexOf('Available skills')).toBeLessThan(
      prompt.indexOf('Latest profile change'),
    );
  });
});
