# Current-app completion additions

The user explicitly added these requirements during the desktop completion
pass. They supersede the earlier navigator composition. The broader shared
memory, single-chat orchestration, and recap direction remains deferred.

## Provider and model selection

- Expose configured ACP providers in the chat composer alongside model choice.
- Prefer the selected session's ACP model options, including configuration
  options and legacy model enumeration. Reflect failures honestly.
- Use configured defaults when an agent does not enumerate models. A public
  model catalog can supply metadata, but does not establish which models an
  installed ACP agent or account can run.
- Preserve Neta's visible conversation when changing provider. A new provider
  needs a new vendor session; private vendor context cannot be transferred.
  The user chose a reviewable Markdown handoff built from missions and prior
  messages. The receiving agent must also be able to inspect earlier history.
- Prepare the handoff without an extra model call. Let the user edit it before
  switching, and provide it with the next prompt rather than automatically
  executing a new turn merely because a provider was selected. This is context
  text, not a claim that ACP supports a portable system-message role.
- A model change within the same provider session keeps native session context.

Implementation status: implemented and covered by backend fake-ACP handoff tests plus composer presentation tests. The final runtime smoke switched fake/test-model to fake2/fixture-fast, queued editable Markdown handoff text, and observed it on the next prompt.

References checked during implementation:
[ACP configuration options](https://agentclientprotocol.com/protocol/v1/session-config-options)
and [Models.dev API documentation](https://github.com/anomalyco/models.dev/blob/dev/README.md).

## Sidebar and project actions

- List workspaces vertically.
- Nest each workspace's online machines beneath it. Do not show offline
  machines in this sidebar.
- Keep subagents and mission details in the workspace content, not in the
  sidebar.
- Provide visible **New Project** and **Open Project** actions.
- Update the corresponding Paper designs as well as the running desktop app.

Implementation status: implemented and covered by the extracted project-actions helper tests. A new project is a named folder in a user-selected parent directory, opened through the existing workspace flow. Existing paths are refused without overwriting; cancellation leaves state unchanged; creation does not initialize Git or install dependencies. Native NSSavePanel interaction remains headless-unverifiable.
