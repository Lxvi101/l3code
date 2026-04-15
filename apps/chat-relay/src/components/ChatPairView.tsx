import { useEffect, useRef } from "react";
import {
  CircleStop,
  Play,
  Trash2,
  ArrowLeftRight,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";
import type { ChatPair } from "../types";
import { MessageBubble } from "./MessageBubble";

interface Props {
  pair: ChatPair;
  onStart: (pairId: string) => void;
  onStop: (pairId: string) => void;
  onDelete: (pairId: string) => void;
}

const statusConfig = {
  idle: {
    icon: Clock,
    label: "Idle",
    color: "text-zinc-500",
    bg: "bg-zinc-800",
  },
  running: {
    icon: Loader2,
    label: "Running",
    color: "text-emerald-400",
    bg: "bg-emerald-950/50",
  },
  paused: {
    icon: Clock,
    label: "Paused",
    color: "text-amber-400",
    bg: "bg-amber-950/50",
  },
  completed: {
    icon: CheckCircle2,
    label: "Completed",
    color: "text-blue-400",
    bg: "bg-blue-950/50",
  },
  stopped: {
    icon: CircleStop,
    label: "Stopped",
    color: "text-zinc-400",
    bg: "bg-zinc-800",
  },
  error: {
    icon: AlertCircle,
    label: "Error",
    color: "text-red-400",
    bg: "bg-red-950/50",
  },
};

export function ChatPairView({ pair, onStart, onStop, onDelete }: Props) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [pair.messages.length]);

  const status = statusConfig[pair.status];
  const StatusIcon = status.icon;
  const isRunning = pair.status === "running";
  const canStart =
    pair.status === "idle" ||
    pair.status === "stopped" ||
    pair.status === "error" ||
    pair.status === "paused";
  const canStop = pair.status === "running" || pair.status === "paused";
  const resumeAtLabel =
    pair.resumeAt && Number.isFinite(Date.parse(pair.resumeAt))
      ? new Date(pair.resumeAt).toLocaleString()
      : pair.resumeAt;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center gap-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">{pair.name}</h2>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-zinc-500">
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-relay-a" />
                {pair.threadA.label}
              </span>
              <ArrowLeftRight className="size-3" />
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-relay-b" />
                {pair.threadB.label}
              </span>
              <span className="text-zinc-600">|</span>
              <span>
                Turn {pair.turnCount}
                {pair.config.maxTurns > 0 ? ` / ${pair.config.maxTurns}` : ""}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Status badge */}
          <div
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${status.bg} ${status.color}`}
          >
            <StatusIcon className={`size-3.5 ${isRunning ? "animate-spin" : ""}`} />
            {status.label}
            {pair.waitingFor && isRunning && (
              <span className="text-zinc-500">
                (waiting for {pair.waitingFor === "A" ? pair.threadA.label : pair.threadB.label})
              </span>
            )}
            {pair.status === "paused" && resumeAtLabel && (
              <span className="text-zinc-500">(retry at {resumeAtLabel})</span>
            )}
          </div>

          {/* Actions */}
          {canStart && (
            <button
              onClick={() => onStart(pair.id)}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500"
            >
              <Play className="size-3.5" />
              {pair.messages.length > 0 ? "Resume" : "Start"}
            </button>
          )}
          {canStop && (
            <button
              onClick={() => onStop(pair.id)}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-600"
            >
              <CircleStop className="size-3.5" />
              Stop
            </button>
          )}
          <button
            onClick={() => onDelete(pair.id)}
            className="rounded-lg p-1.5 text-zinc-600 transition hover:bg-zinc-800 hover:text-red-400"
            title="Delete pair"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {pair.error && (
        <div
          className={`border-b px-6 py-2 text-xs ${
            pair.status === "paused"
              ? "border-amber-900/50 bg-amber-950/30 text-amber-300"
              : "border-red-900/50 bg-red-950/30 text-red-400"
          }`}
        >
          {pair.error}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {pair.messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <ArrowLeftRight className="mx-auto size-12 text-zinc-800" />
              <p className="mt-3 text-sm text-zinc-600">
                No messages yet. Start the relay to begin.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {pair.messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                threadA={pair.threadA}
                threadB={pair.threadB}
              />
            ))}

            {/* Running indicator */}
            {isRunning && (
              <div className="flex items-center gap-2 py-3 text-xs text-zinc-500">
                <span className="flex gap-1">
                  <span
                    className="animate-pulse-dot size-1.5 rounded-full bg-zinc-500"
                    style={{ animationDelay: "0ms" }}
                  />
                  <span
                    className="animate-pulse-dot size-1.5 rounded-full bg-zinc-500"
                    style={{ animationDelay: "300ms" }}
                  />
                  <span
                    className="animate-pulse-dot size-1.5 rounded-full bg-zinc-500"
                    style={{ animationDelay: "600ms" }}
                  />
                </span>
                Waiting for {pair.waitingFor === "A" ? pair.threadA.label : pair.threadB.label}
                ...
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Footer: config summary */}
      <div className="border-t border-zinc-800/60 px-6 py-3">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-600">
          <span>
            Model: <span className="text-zinc-400">{pair.config.modelSelection.model}</span>
          </span>
          <span>
            Mode: <span className="text-zinc-400">{pair.config.runtimeMode}</span>
          </span>
          {pair.config.stopSignal && (
            <span>
              Stop:{" "}
              <code className="rounded bg-zinc-800 px-1 text-zinc-400">
                {pair.config.stopSignal}
              </code>
            </span>
          )}
          {pair.config.modificationsAtoB.length > 0 && (
            <span>
              A{"\u2192"}B mods:{" "}
              <span className="text-amber-500/70">{pair.config.modificationsAtoB.length}</span>
            </span>
          )}
          {pair.config.modificationsBtoA.length > 0 && (
            <span>
              B{"\u2192"}A mods:{" "}
              <span className="text-amber-500/70">{pair.config.modificationsBtoA.length}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
