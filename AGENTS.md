# Filecoin for Agents repository instructions

<!-- intent-skills:start -->
## Skill Loading

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead of downloading a replacement.
Before editing files for a substantial task:

- Run `pnpm exec intent list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm exec intent load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

- Cloudflare: before changing `apps/filecoin-api` or `apps/filecoin-app` server code, `wrangler.jsonc`, or Cloudflare resources, load the `workers-best-practices` and `wrangler` skills.

## Changes and validation

- Before you write a commit message or a pull request title, read [Write commit messages and pull request titles](.github/CONTRIBUTING.md#write-commit-messages-and-pull-request-titles) and follow it. It sets the format, the one-component-per-commit rule, the type that releases a change, and the merge method.
- Add a short JSDoc description for every new type, class, function, or method, with links to relevant references.
- After changes, run the TypeScript, Biome, and existing test checks through `pnpm check` (Turborepo); `pnpm check:fix` applies Biome fixes. Each package's and app's README covers its own development commands. Run `pnpm build` when changing package exports or compilation settings.

## Documentation

- Keep [docs/filecoin/README.md](docs/filecoin/README.md) and [docs/filecoin/architecture.md](docs/filecoin/architecture.md) current in the same change as the code, including the open questions a change answers and the follow-ups it completes.
- When code and these docs disagree, list each inconsistency for the user and let them decide which side is right before you edit either.
- Before you write or edit docs, READMEs, commit messages, or pull request descriptions, read [`.agents/skills/technical-writing/SKILL.md`](.agents/skills/technical-writing/SKILL.md) and [`.agents/skills/unslop/SKILL.md`](.agents/skills/unslop/SKILL.md), and apply both. Read the files directly, because both skills set `disable-model-invocation: true`, so Claude Code can't load them as skills.
