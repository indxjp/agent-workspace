# {{agentName}}

A support agent with one example skill and a chat page that asks for feedback on each answer.

## File map

```text
agents/{{agentName}}.ts          the agent: instructions, and the skill it may use
skills/refund-policy/SKILL.md    a skill: a short policy the agent reads when a question needs it
surfaces/main.ts                 the chat page: greeting, suggested prompts and feedback
evals/{{agentName}}.yaml         three cases `aw eval` runs
agent-workspace.yaml             the project file
```

## Run it

```sh
npm install && npm run dev     # aw dev, with your ANTHROPIC_API_KEY set
npx aw check                   # what would be saved
npx aw chat -p "Can I get a refund?"
npx aw eval                    # runs evals/{{agentName}}.yaml
```

## Change these first

1. `skills/refund-policy/SKILL.md`: replace the policy with yours (`aw dev` uploads it on save).
2. `suggestedPrompts` and `greeting` in `surfaces/main.ts`: the questions your users ask.
3. The eval cases in `evals/{{agentName}}.yaml`: say what must be true of your answers.
