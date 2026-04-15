import { useState } from "react";
import {
  Plug,
  Unplug,
  ArrowLeftRight,
  Wifi,
  WifiOff,
  Server,
} from "lucide-react";
import { useRelay } from "./hooks/useRelay";
import { PairSidebar } from "./components/PairSidebar";
import { ChatPairView } from "./components/ChatPairView";
import { ThreadView } from "./components/ThreadView";
import { CreatePairDialog } from "./components/CreatePairDialog";

function ConnectPanel({
  onConnect,
  connecting,
}: {
  onConnect: (url: string, credential: string) => void;
  connecting: boolean;
}) {
  const [url, setUrl] = useState("http://localhost:3773");
  const [credential, setCredential] = useState("");

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-8">
        <div className="mb-6 text-center">
          <Server className="mx-auto size-10 text-zinc-600" />
          <h1 className="mt-3 text-xl font-bold text-zinc-100">
            Chat Relay
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Connect to a running T3 Code server to create chat pairs.
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              T3 Server URL
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:3773"
              className="w-full rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Pairing Credential
            </label>
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder="One-time pairing token from t3 auth pairing create"
              className="w-full rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
            />
            <p className="mt-1 text-xs text-zinc-600">
              Generate with:{" "}
              <code className="rounded bg-zinc-800 px-1">
                t3 auth pairing create
              </code>
            </p>
          </div>

          <button
            onClick={() => onConnect(url, credential)}
            disabled={!url || !credential || connecting}
            className="w-full rounded-lg bg-zinc-100 py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {connecting ? "Connecting..." : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

type Selection =
  | { kind: "pair"; id: string }
  | { kind: "thread"; id: string }
  | null;

export default function App() {
  const relay = useRelay();
  const [selection, setSelection] = useState<Selection>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const selectedPair =
    selection?.kind === "pair"
      ? relay.pairs.find((p) => p.id === selection.id)
      : undefined;

  const selectedThread =
    selection?.kind === "thread"
      ? relay.threads.find((t) => t.id === selection.id)
      : undefined;

  const handleConnect = (url: string, credential: string) => {
    setIsConnecting(true);
    relay.connectToT3(url, credential);
    setTimeout(() => setIsConnecting(false), 3000);
  };

  // Not connected to relay server
  if (!relay.connected) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="text-center">
          <WifiOff className="mx-auto size-10 text-zinc-700" />
          <p className="mt-3 text-sm text-zinc-500">
            Connecting to relay server...
          </p>
        </div>
      </div>
    );
  }

  // Not connected to T3
  if (!relay.t3Connected) {
    return (
      <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
        {relay.error && (
          <div className="border-b border-red-900/50 bg-red-950/30 px-6 py-2 text-center text-sm text-red-400">
            {relay.error}
            <button
              onClick={relay.clearError}
              className="ml-3 underline hover:no-underline"
            >
              dismiss
            </button>
          </div>
        )}
        <ConnectPanel
          onConnect={handleConnect}
          connecting={isConnecting}
        />
      </div>
    );
  }

  // Main UI
  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center gap-3">
          <ArrowLeftRight className="size-4 text-zinc-500" />
          <span className="text-sm font-semibold text-zinc-300">
            Chat Relay
          </span>
        </div>

        <div className="flex items-center gap-4">
          {relay.error && (
            <span className="text-xs text-red-400">
              {relay.error}
              <button
                onClick={relay.clearError}
                className="ml-2 underline hover:no-underline"
              >
                dismiss
              </button>
            </span>
          )}

          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Wifi className="size-3.5 text-emerald-500" />
            <span className="text-emerald-500/70">{relay.t3Url}</span>
          </div>

          <button
            onClick={relay.disconnectFromT3}
            className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-700 hover:text-zinc-200"
          >
            <Unplug className="size-3.5" />
            Disconnect
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <PairSidebar
          pairs={relay.pairs}
          threads={relay.threads}
          selectedPairId={selection?.kind === "pair" ? selection.id : null}
          selectedThreadId={selection?.kind === "thread" ? selection.id : null}
          onSelectPair={(id) => setSelection({ kind: "pair", id })}
          onSelectThread={(id) => setSelection({ kind: "thread", id })}
          onCreateNew={() => setShowCreateDialog(true)}
        />

        <div className="flex-1">
          {selectedPair ? (
            <ChatPairView
              pair={selectedPair}
              onStart={relay.startPair}
              onStop={relay.stopPair}
              onDelete={(id) => {
                relay.deletePair(id);
                setSelection(null);
              }}
            />
          ) : selectedThread ? (
            <ThreadView thread={selectedThread} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <Plug className="mx-auto size-12 text-zinc-800" />
                <p className="mt-3 text-sm text-zinc-600">
                  Select a pair or thread from the sidebar, or create a new pair.
                </p>
                <button
                  onClick={() => setShowCreateDialog(true)}
                  className="mt-4 rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-700"
                >
                  Create Chat Pair
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showCreateDialog && (
        <CreatePairDialog
          projects={relay.projects}
          onClose={() => setShowCreateDialog(false)}
          onCreate={relay.createPair}
        />
      )}
    </div>
  );
}
