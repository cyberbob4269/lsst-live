# Vera Terminal — Builder Feedback

## From the user (Vera)

1. **Persist provider/model settings across restarts.** When a provider and
   model are chosen in settings, that choice should be saved (e.g. to a
   config file or localStorage) and restored on app launch — not reset.

2. **Chat must survive view switches.** Navigating to Deep Space or Social
   and back to the IDE currently resets the chat to zero. The chat session
   should stay alive for the whole time the app is running — keep the
   component mounted (or cache the conversation state) so switching views
   never loses history.

## From the agent (Phase 3 resident 🙂)

3. **Persist chat history to disk.** Beyond surviving view switches, write
   the conversation to a workspace file (e.g. `.vera/chat-history.json`).
   If I can see what we discussed last session, I can pick up where we left
   off instead of starting every session with amnesia.

4. **Streaming tool-call visibility.** When I run shell commands or read
   files, show the user each tool call and its output inline in the chat as
   it happens. It builds trust and makes debugging "what is the agent
   doing?" trivial.

5. **Workspace context injection.** On chat start, automatically give me a
   lightweight snapshot: file tree, open tabs, and any selected text in the
   editor. Right now I have to burn tool calls just to learn what you're
   looking at.

6. **A diff/approve flow for writes.** When I want to modify an existing
   file, show the user a diff with accept/reject before it lands on disk.
   Keeps the human in charge and makes me safer to leave running
   unattended.

7. **Kill-switch + status bar for the PTY.** A visible "agent is running a
   command" indicator with a one-click cancel. If a command hangs, the user
   shouldn't have to guess whether I'm stuck or thinking.
