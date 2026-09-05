# AgentChatKit

`AgentChatKit` is a native SwiftUI renderer for agent conversations on macOS 26. Apps adapt their wire model into `AgentChatBlock`, render it with `AgentMessageBlockView`, and show `AgentProgressView` while a response is preparing, streaming, or stopping. The package has no provider or transport dependency.

Markdown uses native `AttributedString` rendering for inline content and
dedicated block views for headings, paragraphs, quotes, nested ordered and
unordered lists, checklists, simple pipe tables, and backtick or tilde fenced
code. Fences match their opening delimiter and length, including partial
streaming fences. This is a deliberate agent-chat subset, not a claim of full
CommonMark compatibility. Tool calls use an expandable native
`DisclosureGroup`; usage is represented by `AgentUsage` so raw provider token
dictionaries never leak into the transcript.

Catch-up surfaces adapt durable records into `AgentGlanceCard` and render them
with `AgentGlanceCardView`. The host owns expansion through a `Binding` and
handles the source and review callbacks, so the package does not infer read
state or depend on any transport or summarization service.
