## Problem Statement

The extension currently treats the Root agent and Task Sub-agents differently. A selected Root persona is layered over Pi's native prompt composition, while Task Sub-agents are created through the extension's own persistent Sub-agent lifecycle. This leaves a hidden non-markdown "main agent" path, makes prompt context inheritance implicit, and causes project context files such as AGENTS.md to be appended automatically even when an Agent definition did not explicitly request them.

The user wants every Agent definition to be functionally symmetric: the same markdown-backed Agent definition should be able to run as the Root agent or as a Sub-agent, with identical prompt composition semantics. The only difference should be runtime placement facts such as whether the session is the Root agent or a persisted Sub-agent. The previous normal Pi coding assistant should continue to exist, but only as a normal built-in Agent definition selected by default configuration.

## Solution

Introduce a fully symmetric Agent definition prompt path for both Root agents and Task Sub-agents. The Root agent always resolves to an Agent definition: either the session-local `/agent` selection or the configured Default Root agent definition. The built-in default Root agent definition defaults to `default`, and a built-in `default` Agent definition recreates the missing portions of the previous normal Pi coding-assistant prompt.

Prompt composition should stop preserving Pi's hidden generic suffix for Agent definitions. Instead, an Agent definition's markdown plus universal prompt parts become the full prompt contract. Project context files are no longer automatically injected into Task Sub-agent prompts; they appear only when a template explicitly uses `{{context_files}}`. Skill prompt content is selected through a new Agent definition `skills` field with tri-state semantics: missing means all inherited skills, blank means no skills, and a comma-separated list means only those skill prompt contents are included.

Task registration becomes cleaner: if an agent has no spawnable Task targets under DepthPolicy/canSpawn rules, the Task tool is not registered at all. Internal tree metadata remains internal and is removed from prompt variables.

## User Stories

1. As a user, I want the Root agent and Sub-agents to use the same Agent definition semantics, so that I can reason about agents uniformly.
2. As a user, I want the old normal Pi coding assistant to exist as a markdown Agent definition, so that I can inspect and override it like any other agent.
3. As a user, I want the configured Default Root agent definition to select the Root fallback, so that no hidden non-markdown main-agent behavior remains.
4. As a user, I want `/agent` to override the Root agent only for the current session, so that configuration remains the source of truth for future default sessions.
5. As a user, I want new sessions to fall back to the configured Default Root agent definition, so that `/agent` choices do not silently mutate global defaults.
6. As a user, I want a missing configured Default Root agent definition to be a hard error, so that configuration mistakes are visible instead of silently falling back to raw Pi behavior.
7. As a project maintainer, I want `default` to be a normal Agent definition, so that no functional special cases accumulate around it.
8. As a project maintainer, I want Root-vs-Sub-agent placement to not change prompt composition, so that tests and documentation can describe one prompt pipeline.
9. As an agent author, I want project context files to appear only when I use `{{context_files}}`, so that I control where AGENTS.md-style material appears.
10. As an agent author, I want project context files to not be appended automatically by Pi's generic section for Sub-agents, so that prompts do not contain duplicated or unexpected context.
11. As an agent author, I want a `skills` frontmatter field, so that I can control which skill prompt content an Agent definition receives.
12. As an agent author, I want missing `skills` to mean all skills, so that existing Agent definitions keep their current behavior unless they opt in.
13. As an agent author, I want blank `skills` to mean no skill prompt content, so that I can create highly focused agents.
14. As an agent author, I want comma-separated `skills` values to allow only named skills, so that agent prompts receive relevant skill guidance without unrelated skill noise.
15. As an agent author, I want skill selection to affect prompt content only, so that runtime availability and user-invoked skills are not unexpectedly disabled.
16. As an agent author, I want skill filtering to apply everywhere in the render context, so that `{{skills}}` in any prompt fragment sees the same selected skill list.
17. As a Root agent, I want Task to be unavailable when no agents are spawnable, so that the tool surface accurately reflects what I can do.
18. As a Sub-agent, I want Task to be unavailable when no agents are spawnable, so that leaf agents are not prompted to delegate work they cannot delegate.
19. As an agent author, I do not want prompt variables for parent IDs or depth, so that internal tree metadata does not leak into prompts unnecessarily.
20. As a maintainer, I want DepthPolicy to remain the enforcement source for Task spawning, so that prompt wording is not relied on for security or correctness.
21. As a maintainer, I want Task tool registration to reflect DepthPolicy/canSpawn decisions, so that tool availability and enforcement stay aligned.
22. As a maintainer, I want the prompt composition module to be a deeper module, so that Root and Sub-agent rendering behavior can be tested through one stable interface.
23. As a maintainer, I want Agent discovery/config parsing to own new frontmatter parsing, so that downstream modules receive normalized Agent definitions.
24. As a maintainer, I want resource loading for Sub-agents to disable native context file injection, so that context file inclusion is explicitly controlled by templates.
25. As a maintainer, I want Root prompt replacement to be complete under the extension's prompt path, so that there is no hidden raw Pi main-agent path.
26. As a maintainer, I want existing prompt parts and WIP Agent definition markdowns to remain otherwise unrefactored, so that this change stays focused.
27. As a user comparing this extension to pi-subagents, I want only the accepted improvements implemented, so that rejected features do not expand the tool beyond its intended scope.
28. As a tester, I want behavior-focused tests for Root/Sub-agent prompt symmetry, so that implementation details can change without breaking tests unnecessarily.
29. As a tester, I want tests for Task hiding when no spawnable agents exist, so that leaf behavior is enforced at the interface.
30. As a tester, I want tests for `skills` tri-state parsing/rendering, so that agent authors get predictable prompt content.

## Implementation Decisions

- Build/modify a Root agent selection module/interface that resolves the effective Root Agent definition from session-local Root agent selection or configured Default Root agent definition.
- Add extension configuration for `defaultRootAgent`, with a default value of `default`.
- Add a built-in Agent definition named `default`. It is a normal Agent definition and must not receive functional special cases. Its content should include only the portions needed to recreate the previous normal Pi coding-assistant behavior that are not already supplied by current universal prompt parts.
- Preserve `/agent` as a session-local Root agent selection mechanism. `/agent` does not mutate default configuration.
- Make missing configured Default Root agent definition a hard error.
- Replace the old asymmetric Root prompt path with the same Agent definition prompt composition path used by Task Sub-agents.
- Stop preserving Pi's hidden generic system-prompt suffix for Agent definitions.
- Do not support Pi append-system prompt material in the new Agent definition prompt path. Universal prompt parts and Agent definition markdown replace that mechanism for this extension.
- Disable native automatic project context file injection for Task Sub-agents. Project context files are available to the extension render context and appear only through explicit `{{context_files}}` usage.
- Do not add `inheritProjectContext` or `inheritSkills`. The accepted replacement is explicit context-file template usage and `skills` selection.
- Add `skills` to Agent definition frontmatter using the same comma-string style as existing list fields.
- Normalize `skills` with tri-state semantics: missing means all skill prompt content; present but blank means no skill prompt content; present with values means only matching named skill prompt content.
- Apply skill filtering to the complete render context so all prompt templates and prompt parts see the same selected skill list.
- Keep skill selection limited to prompt content. It does not hard-disable runtime tools, extensions, or user-invoked skills.
- Remove prompt variables for depth and parent agent ID. Do not add replacement variables for spawn depth or spawnable agents.
- Hide/unregister Task when DepthPolicy/canSpawn yields no spawnable Agent definitions. Apply this uniformly to Root agents and Sub-agents.
- Keep DepthPolicy as the single source of truth for spawn permission enforcement.
- Keep full symmetry: Agent definitions are normal whether selected as Root fallback, explicitly selected as Root, or spawned as Sub-agents.

## Testing Decisions

- Tests should assert external behavior rather than implementation details: rendered prompt contents, Root agent resolution outcomes, Task tool registration presence/absence, and normalized Agent configuration.
- Agent discovery/config tests should cover `skills` tri-state parsing: missing, blank, and comma-list values.
- Prompt rendering tests should cover skill filtering in the render context and removal of `depth` and `parent_agent_id` variables from the required variable set.
- Integration tests should cover that Root prompt composition and Sub-agent prompt composition use the same semantics for Agent definitions.
- Integration tests should cover that Task is not registered when no Agent definitions are spawnable under the active DepthPolicy/canSpawn state.
- Integration tests should cover that configured Default Root agent definition resolution errors when the configured name does not exist.
- Existing task utility tests provide prior art for pure prompt rendering, metadata helpers, spawn permission checks, and Agent resolution.
- Existing command/integration tests provide prior art for extension loading, tool registration, and `/agent` command behavior.
- Tests should avoid asserting exact full prompt text where possible; instead they should assert presence/absence of semantically important sections such as context files, skills, and Task availability.

## Out of Scope

- Output truncation or output artifacts.
- Built-in agent override settings.
- Packaged workflow prompt templates.
- Refactoring existing WIP Agent definition markdowns beyond adding the required `default` Agent definition and removing obsolete prompt variables if present.
- Model fallback support.
- Agent management actions such as list/get/create/update/delete through the Task tool.
- Fork/fresh context modes.
- Chain or parallel orchestration modes in the Task schema.
- Async/background Sub-agent runs.
- Intercom or supervisor-contact coordination.
- Prompt variables for spawn depth, spawnable agents, tree depth, or parent agent ID.
- Pi append-system prompt support in the new Agent definition prompt path.

## Further Notes

The core architectural direction is to make Agent definition prompt composition a deep module with one stable interface used by both Root agents and Sub-agents. The Root agent remains tree depth 0 at runtime, and Sub-agents remain persistent sessions with metadata records, but prompt semantics should not depend on that placement.

This PRD intentionally captures only the accepted subset of improvements from the comparison with pi-subagents. Features that would broaden the Task tool schema or introduce additional lifecycle systems are explicitly out of scope.
