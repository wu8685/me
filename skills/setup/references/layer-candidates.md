# Layer Directory Candidates

When scanning for existing directories that may serve as knowledge layers:

## Raw layer candidates
`raw`, `research`, `调研`, `references`, `sources`

## Practices layer candidates
`practices`, `practice`, `实践`, `experiments`, `notes`

## Cognition layer candidates
`cognition`, `insights`, `认知`, `knowledge`, `distilled`

## Detection script

```bash
for dir in raw research 调研 references sources; do
  [ -d "$dir" ] && echo "raw candidate: $dir"
done
for dir in practices practice 实践 experiments notes; do
  [ -d "$dir" ] && echo "practices candidate: $dir"
done
for dir in cognition insights 认知 knowledge distilled; do
  [ -d "$dir" ] && echo "cognition candidate: $dir"
done
```

## User interaction

If candidates found, present them:

```
Detected existing directories that could serve as knowledge layers:
  - 调研/ (suggested: raw layer)
  - 实践/ (suggested: practices layer)

Map these directories to layers? (Press Enter to use defaults: raw/practices/cognition)
  Raw layer [raw]: 调研
  Practices layer [practices]: 实践
  Cognition layer [cognition]: cognition
```

Since this is an agent skill (no stdin), present detected directories with suggested mappings and ask the user to confirm or provide alternatives via conversation.

If the user confirms, use those. If "use defaults" or no candidates found, use defaults: `raw`, `practices`, `cognition`.
