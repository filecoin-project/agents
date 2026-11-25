# Skills

The agent skill tells an agent when to use `filecoin`, which steps to follow, and which rules to keep. For commands and flags, it sends the agent to the CLI's own help, which always matches the installed version.

The [agent plugin](/agents/plugin) includes the skill. Install the skill on its own only in an agent that doesn't support the plugin.

## Install

```sh
npx skills add filecoin-project/agents
```

`npx skills add https://poc.filecoin.cloud` installs the same skill from this site. Agents that support [agent skills discovery](https://github.com/cloudflare/agent-skills-discovery-rfc) find the skill at [`/.well-known/agent-skills/index.json`](/.well-known/agent-skills/index.json).

To install the copy that matches your installed CLI, run `filecoin skills install`. The command writes the skill to the current project. Add `--scope global` to install it for your user instead.

## How the skill runs the CLI

The agent runs the [`filecoin` package on npm](https://www.npmjs.com/package/filecoin) with `npx -y filecoin`, which needs Node.js 24 or newer. To install the package instead, run `npm install -g filecoin`.

The first `filecoin login` asks you to [approve the agent's key](/agents#approve-the-agents-key).
