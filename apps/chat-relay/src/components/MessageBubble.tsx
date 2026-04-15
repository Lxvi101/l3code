import type { RelayMessage, ThreadInfo } from "../types";

interface Props {
  message: RelayMessage;
  threadA: ThreadInfo;
  threadB: ThreadInfo;
}

export function MessageBubble({ message, threadA, threadB }: Props) {
  const isSystem = message.source === "system";
  const isA = message.source === "A";
  const isB = message.source === "B";

  const label = isA ? threadA.label : isB ? threadB.label : "System";

  const isAssistant = message.role === "assistant";
  const isRelayed = message.role === "user" && message.relayedText;

  if (isSystem) {
    return (
      <div className="animate-slide-in flex justify-center py-2">
        <div className="inline-flex items-center gap-2 rounded-full bg-zinc-800/60 px-4 py-1.5 text-xs text-zinc-400">
          <span className="size-1.5 rounded-full bg-relay-system" />
          {message.originalText}
        </div>
      </div>
    );
  }

  if (isRelayed) {
    // This is a relayed message — show it as a compact arrow indicator
    const direction = isA
      ? `${threadA.label} \u2192 ${threadB.label}`
      : `${threadB.label} \u2192 ${threadA.label}`;
    return (
      <div className="animate-slide-in flex justify-center py-1">
        <div className="inline-flex items-center gap-2 rounded-full bg-zinc-800/40 px-3 py-1 text-xs text-zinc-500">
          <span>{direction}</span>
          {message.relayedText !== message.originalText && (
            <span className="text-amber-500/70">(modified)</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`animate-slide-in flex flex-col gap-1 py-2 ${isA ? "items-start" : "items-end"}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-1">
        <span className={`size-2 rounded-full ${isA ? "bg-relay-a" : "bg-relay-b"}`} />
        <span className="text-xs font-medium text-zinc-400">{label}</span>
        <span className="text-xs text-zinc-600">{isAssistant ? "responded" : "sent"}</span>
        <span className="text-xs text-zinc-700">T{message.turnNumber}</span>
      </div>

      {/* Message body */}
      <div
        className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
          isA
            ? "bg-relay-a/10 text-zinc-200 rounded-tl-sm"
            : "bg-relay-b/10 text-zinc-200 rounded-tr-sm"
        }`}
      >
        <pre className="whitespace-pre-wrap break-words font-sans">{message.originalText}</pre>
      </div>
    </div>
  );
}
