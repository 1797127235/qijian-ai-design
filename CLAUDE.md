## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules (addyosmani/agent-skills):
- Underspecified ask / requirements interview -> invoke /interview-me
- Vague product idea -> invoke /idea-refine
- New feature or significant change -> invoke /spec-driven-development
- Have a spec, need tasks -> invoke /planning-and-task-breakdown
- Implement changes -> invoke /incremental-implementation + /test-driven-development
- Bugs / unexpected behavior -> invoke /debugging-and-error-recovery
- Code review before merge -> invoke /code-review-and-quality
- Simplify working but messy code -> invoke /code-simplification
- Security-sensitive work -> invoke /security-and-hardening
- Performance concerns -> invoke /performance-optimization
- Ship / launch -> invoke /shipping-and-launch
- Discover which skill applies -> invoke /using-agent-skills
