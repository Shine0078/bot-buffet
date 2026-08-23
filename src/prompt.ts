/**
 * Build the system message for a run.
 *
 * `skills` was declared on every profile and used nowhere, so an agent never
 * learned that its own skills existed. They are listed here by name only --
 * progressive disclosure: the agent is told what is available and can read the
 * detail through its file tools when it decides a skill is relevant, rather
 * than having every skill's full text occupy the context budget on every step.
 */
import { outputFormatInstruction, type OutputFormat } from './outputFormat.js';

export function buildSystemPrompt(profile: {
  systemInstructions: string;
  projectRules: string[];
  skills: string[];
  outputFormat?: OutputFormat;
  changelog?: string[];
  description?: string;
}): string {
  const sections = [profile.systemInstructions];
  const description = profile.description?.trim();
  if (description) sections.push('Agent description: ' + description);
  if (profile.projectRules.length) {
    sections.push('Project rules:\n' + profile.projectRules.map((rule) => '- ' + rule).join('\n'));
  }
  if (profile.skills.length) {
    sections.push(
      'Available skills (read the referenced material before relying on one):\n' +
        profile.skills.map((skill) => '- ' + skill).join('\n'),
    );
  }
  const latestChange = profile.changelog?.filter((entry) => entry.trim()).at(-1);
  if (latestChange) {
    sections.push('Latest profile change: ' + latestChange);
  }
  const formatInstruction = outputFormatInstruction(profile.outputFormat ?? 'text');
  if (formatInstruction) sections.push(formatInstruction);
  return sections.join('\n\n');
}
