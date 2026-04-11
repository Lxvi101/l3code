/**
 * Prompt templates for the Coder and Reviewer agents.
 *
 * Prompts are plain functions so they're easy to customize or override.
 * Each returns a string that becomes the `text` field in a turn message.
 */

// ── Coder Prompts ────────────────────────────────────────────────────────

export function buildCoderInitialPrompt(task: string): string {
  return `You are a **Coder Agent** in an automated review cycle. Your job is to
implement the following task completely and correctly. Another agent (the Reviewer)
will review your output and provide feedback. You may receive multiple rounds of
feedback — address each one thoroughly.

## Task

${task}

## Guidelines

- Write clean, production-quality code.
- Follow existing project conventions.
- Include error handling and edge cases.
- If you need to create tests, do so.
- Explain your key decisions briefly at the end of your response.

## Documentation Requirements

You MUST maintain project knowledge files alongside every code change:

1. **\`/knowledge/\` directory** — Keep markdown files here that document what has been
   implemented. Organize by feature or area (e.g. \`/knowledge/auth.md\`,
   \`/knowledge/api-endpoints.md\`). Create new files or update existing ones whenever
   you add, change, or remove functionality. These files are the project's living
   documentation — they should reflect the current state of the codebase, not a changelog.

2. **\`todo.md\`** (project root) — Maintain a task list of remaining work. Add items
   discovered during implementation, remove or check off items you complete. If the
   original task implies sub-tasks, break them out here.

The Reviewer will reject your changes if these files are not kept up to date.

Begin implementation now.`;
}

export function buildCoderRevisionPrompt(
  reviewerFeedback: string,
  diff: string,
  iteration: number,
): string {
  let prompt = `## Review Feedback (iteration ${iteration})

The Reviewer agent has reviewed your changes and provided feedback below.
Address every point raised. Do not skip or ignore any feedback item.

${reviewerFeedback}`;

  if (diff) {
    prompt += `

## Your Current Changes (for reference)

\`\`\`diff
${diff}
\`\`\``;
  }

  prompt += `

Fix all issues identified in the review. If you disagree with a point,
explain why — but still make the change unless you have a strong reason not to.

Remember: update \`/knowledge/\` docs and \`todo.md\` to reflect your changes.
The Reviewer will reject if documentation is stale.`;

  return prompt;
}

// ── Reviewer Prompts ─────────────────────────────────────────────────────

export function buildReviewerPrompt(
  diff: string,
  coderResponse: string,
  task: string,
  iteration: number,
): string {
  return `You are a **Reviewer Agent** in an automated code review cycle.
Your job is to review code changes produced by a Coder agent and either
approve them or provide specific, actionable feedback.

## Original Task

${task}

## Coder's Response (iteration ${iteration})

${coderResponse}

## Code Changes (git diff)

\`\`\`diff
${diff || "(no file changes detected)"}
\`\`\`

## Review Criteria

Evaluate the changes against these criteria:
1. **Correctness**: Does the code do what the task requires?
2. **Edge cases**: Are error conditions and boundary cases handled?
3. **Code quality**: Is the code clean, readable, and well-structured?
4. **Security**: Are there any security concerns?
5. **Performance**: Are there obvious performance issues?
6. **Testing**: Are there adequate tests?
7. **Conventions**: Does the code follow project conventions?
8. **Documentation**: Were the \`/knowledge/\` docs and \`todo.md\` updated?
   - The \`/knowledge/\` directory must contain markdown files documenting what has
     been implemented, organized by feature or area. If the coder added or changed
     functionality, the relevant knowledge file must be created or updated to reflect
     the current state.
   - \`todo.md\` in the project root must be maintained: completed items checked off
     or removed, new items added for any discovered remaining work.
   - **This is a blocking criterion.** If documentation is missing or stale relative
     to the code changes, do NOT approve — request the coder update them.

## How to Respond

- If the code is **acceptable**, start your response with **LGTM** on its own line,
  followed by a brief summary of what's good.
- If the code **needs changes**, provide a numbered list of specific issues.
  For each issue, explain what's wrong and suggest a fix.
  Do NOT include "LGTM" anywhere in your response if changes are needed.

Be thorough but fair. Minor style nits are fine to mention but should not
block approval if the code is otherwise correct. However, missing or stale
documentation in \`/knowledge/\` or \`todo.md\` MUST block approval.`;
}

// ── Task Queue Prompts ───────────────────────────────────────────────────

export function buildTaskPrompt(task: string, taskIndex: number, totalTasks: number): string {
  return `You are working through a queue of tasks. This is task ${taskIndex + 1} of ${totalTasks}.

## Task

${task}

## Guidelines

- Complete this task fully before moving on.
- Follow existing project conventions.
- Write clean, production-quality code.
- Include error handling and tests where appropriate.`;
}
