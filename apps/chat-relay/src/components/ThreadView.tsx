import { MessageSquare, Hash } from "lucide-react";
import type { ThreadSummary } from "../types";

interface Props {
  thread: ThreadSummary;
}

export function ThreadView({ thread }: Props) {
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-zinc-800 px-6 py-4">
        <Hash className="size-5 text-zinc-500" />
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">
            {thread.title}
          </h2>
          <div className="mt-0.5 flex items-center gap-3 text-xs text-zinc-500">
            <span>{thread.messageCount} messages</span>
            {thread.pairId && (
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
                Relay pair {thread.pairSide}
              </span>
            )}
            {thread.turnState && (
              <span
                className={
                  thread.turnState === "running"
                    ? "text-emerald-400"
                    : thread.turnState === "error"
                      ? "text-red-400"
                      : "text-zinc-400"
                }
              >
                {thread.turnState}
              </span>
            )}
            <span className="font-mono text-zinc-700">{thread.id}</span>
          </div>
        </div>
      </div>

      {/* Content — preview from snapshot */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {thread.messageCount === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <MessageSquare className="mx-auto size-12 text-zinc-800" />
              <p className="mt-3 text-sm text-zinc-600">
                This thread has no messages yet.
              </p>
            </div>
          </div>
        ) : (
          <div className="text-center text-sm text-zinc-500">
            <MessageSquare className="mx-auto mb-3 size-10 text-zinc-700" />
            <p>
              This thread has <strong className="text-zinc-300">{thread.messageCount}</strong> messages.
            </p>
            {thread.lastMessagePreview && (
              <p className="mx-auto mt-3 max-w-lg rounded-lg bg-zinc-900 p-3 text-left text-xs text-zinc-400">
                {thread.lastMessagePreview}...
              </p>
            )}
            {thread.pairId && (
              <p className="mt-4 text-xs text-zinc-600">
                Select the relay pair in the sidebar to see the full conversation.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-zinc-800/60 px-6 py-3">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-600">
          <span>
            Thread: <code className="rounded bg-zinc-800 px-1 text-zinc-400">{thread.id}</code>
          </span>
          <span>
            Project: <code className="rounded bg-zinc-800 px-1 text-zinc-400">{thread.projectId}</code>
          </span>
          {thread.lastActivityAt && (
            <span>
              Last activity: <span className="text-zinc-400">{new Date(thread.lastActivityAt).toLocaleString()}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
