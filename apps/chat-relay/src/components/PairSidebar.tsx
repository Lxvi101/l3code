import {
  ArrowLeftRight,
  CheckCircle2,
  CircleStop,
  Loader2,
  AlertCircle,
  Clock,
  Plus,
  MessageSquare,
  Hash,
} from "lucide-react";
import type { ChatPair, PairStatus, ThreadSummary } from "../types";

interface Props {
  pairs: ChatPair[];
  threads: ThreadSummary[];
  selectedPairId: string | null;
  selectedThreadId: string | null;
  onSelectPair: (pairId: string) => void;
  onSelectThread: (threadId: string) => void;
  onCreateNew: () => void;
}

const statusIcons: Record<PairStatus, typeof Clock> = {
  idle: Clock,
  running: Loader2,
  paused: Clock,
  completed: CheckCircle2,
  stopped: CircleStop,
  error: AlertCircle,
};

const statusColors: Record<PairStatus, string> = {
  idle: "text-zinc-500",
  running: "text-emerald-400",
  paused: "text-amber-400",
  completed: "text-blue-400",
  stopped: "text-zinc-500",
  error: "text-red-400",
};

export function PairSidebar({
  pairs,
  threads,
  selectedPairId,
  selectedThreadId,
  onSelectPair,
  onSelectThread,
  onCreateNew,
}: Props) {
  // Threads NOT belonging to any pair (non-relay threads from T3)
  const pairThreadIds = new Set(
    pairs.flatMap((p) => [p.threadA.id, p.threadB.id]),
  );
  const standaloneThreads = threads.filter((t) => !pairThreadIds.has(t.id));

  return (
    <div className="flex h-full w-72 flex-col border-r border-zinc-800 bg-zinc-950">
      {/* Pairs header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="size-4 text-zinc-400" />
          <span className="text-sm font-semibold text-zinc-200">
            Chat Pairs
          </span>
          <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500">
            {pairs.length}
          </span>
        </div>
        <button
          onClick={onCreateNew}
          className="rounded-lg bg-zinc-800 p-1.5 text-zinc-400 transition hover:bg-zinc-700 hover:text-zinc-200"
          title="Create new pair"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Pair list */}
        <div className="p-2">
          {pairs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <ArrowLeftRight className="size-8 text-zinc-800" />
              <p className="mt-3 text-xs text-zinc-600">
                No pairs yet.
                <br />
                Create one to get started.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {pairs.map((pair) => {
                const Icon = statusIcons[pair.status];
                const isSelected = pair.id === selectedPairId;

                return (
                  <button
                    key={pair.id}
                    onClick={() => onSelectPair(pair.id)}
                    className={`w-full rounded-lg px-3 py-2.5 text-left transition ${
                      isSelected
                        ? "bg-zinc-800 ring-1 ring-zinc-700"
                        : "hover:bg-zinc-900"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-zinc-200 truncate">
                        {pair.name}
                      </span>
                      <Icon
                        className={`size-3.5 flex-shrink-0 ${statusColors[pair.status]} ${
                          pair.status === "running" ? "animate-spin" : ""
                        }`}
                      />
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                      <span className="truncate">
                        {pair.threadA.label} / {pair.threadB.label}
                      </span>
                      <span className="flex-shrink-0 text-zinc-700">
                        T{pair.turnCount}
                      </span>
                    </div>
                    {pair.messages.length > 0 && (
                      <p className="mt-1 truncate text-xs text-zinc-600">
                        {pair.messages[pair.messages.length - 1].originalText.slice(0, 60)}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* All T3 Threads section */}
        {threads.length > 0 && (
          <>
            <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-2.5">
              <MessageSquare className="size-3.5 text-zinc-500" />
              <span className="text-xs font-semibold text-zinc-400">
                All T3 Threads
              </span>
              <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-600">
                {threads.length}
              </span>
            </div>
            <div className="space-y-0.5 px-2 pb-2">
              {threads.map((thread) => {
                const isSelected = thread.id === selectedThreadId;
                const isPairThread = pairThreadIds.has(thread.id);

                return (
                  <button
                    key={thread.id}
                    onClick={() => onSelectThread(thread.id)}
                    className={`w-full rounded-lg px-3 py-2 text-left transition ${
                      isSelected
                        ? "bg-zinc-800 ring-1 ring-zinc-700"
                        : "hover:bg-zinc-900"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <Hash className="size-3 flex-shrink-0 text-zinc-600" />
                      <span className="truncate text-xs font-medium text-zinc-300">
                        {thread.title}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 pl-4.5 text-xs text-zinc-600">
                      <span>{thread.messageCount} msgs</span>
                      {isPairThread && thread.pairSide && (
                        <span className="rounded bg-zinc-800 px-1 text-zinc-500">
                          relay {thread.pairSide}
                        </span>
                      )}
                      {thread.turnState === "running" && (
                        <span className="text-emerald-500">running</span>
                      )}
                    </div>
                    {thread.lastMessagePreview && (
                      <p className="mt-0.5 truncate pl-4.5 text-xs text-zinc-700">
                        {thread.lastMessagePreview}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
