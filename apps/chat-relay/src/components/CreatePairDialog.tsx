import { useState, type ReactNode } from "react";
import { Plus, X, ArrowRight, Wand2 } from "lucide-react";
import type { Modification, PairConfig, T3Project } from "../types";

interface Props {
  projects: T3Project[];
  onClose: () => void;
  onCreate: (config: PairConfig) => void;
}

function ModificationEditor({
  label,
  modifications,
  onChange,
}: {
  label: ReactNode;
  modifications: Modification[];
  onChange: (mods: Modification[]) => void;
}) {
  const addMod = () => {
    onChange([...modifications, { type: "prefix", value: "" }]);
  };

  const removeMod = (index: number) => {
    onChange(modifications.filter((_, i) => i !== index));
  };

  const updateMod = (index: number, updates: Partial<Modification>) => {
    onChange(
      modifications.map((m, i) =>
        i === index ? { ...m, ...updates } : m,
      ),
    );
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="block text-xs font-medium text-zinc-400">
          {label}
        </label>
        <button
          type="button"
          onClick={addMod}
          className="flex items-center gap-1 text-xs text-zinc-500 transition hover:text-zinc-300"
        >
          <Plus className="size-3" />
          Add
        </button>
      </div>

      {modifications.length === 0 ? (
        <p className="text-xs text-zinc-600 italic">
          No modifications. Output will be relayed as-is.
        </p>
      ) : (
        <div className="space-y-2">
          {modifications.map((mod, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-lg bg-zinc-800/50 p-2"
            >
              <select
                value={mod.type}
                onChange={(e) =>
                  updateMod(i, {
                    type: e.target.value as Modification["type"],
                  })
                }
                className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-200"
              >
                <option value="prefix">Prefix</option>
                <option value="suffix">Suffix</option>
                <option value="replace">Replace</option>
                <option value="wrap">Wrap</option>
              </select>

              <div className="flex-1 space-y-1">
                {mod.type === "replace" && (
                  <input
                    type="text"
                    value={mod.pattern ?? ""}
                    onChange={(e) =>
                      updateMod(i, { pattern: e.target.value })
                    }
                    placeholder="Regex pattern..."
                    className="w-full rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600"
                  />
                )}
                <textarea
                  value={mod.value}
                  onChange={(e) =>
                    updateMod(i, { value: e.target.value })
                  }
                  placeholder={
                    mod.type === "wrap"
                      ? "Use {{message}} as placeholder..."
                      : mod.type === "replace"
                        ? "Replacement text..."
                        : "Text to add..."
                  }
                  rows={2}
                  className="w-full rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600"
                />
              </div>

              <button
                type="button"
                onClick={() => removeMod(i)}
                className="rounded p-1 text-zinc-600 transition hover:text-red-400"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MODELS_BY_PROVIDER: Record<
  "claudeAgent" | "codex",
  { id: string; label: string }[]
> = {
  claudeAgent: [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  codex: [
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { id: "gpt-5.2", label: "GPT-5.2" },
  ],
};

const DEFAULT_MODELS: Record<"claudeAgent" | "codex", string> = {
  claudeAgent: "claude-sonnet-4-6",
  codex: "gpt-5.4",
};

export function CreatePairDialog({ projects, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [provider, setProvider] = useState<"claudeAgent" | "codex">("claudeAgent");
  const [model, setModel] = useState(DEFAULT_MODELS.claudeAgent);
  const [runtimeMode, setRuntimeMode] = useState<PairConfig["runtimeMode"]>("full-access");
  const [labelA, setLabelA] = useState("Agent A");
  const [labelB, setLabelB] = useState("Agent B");
  const [initialMessage, setInitialMessage] = useState("");
  const [stopSignal, setStopSignal] = useState("\\[STOP\\]");
  const [maxTurns, setMaxTurns] = useState(10);
  const [modsAtoB, setModsAtoB] = useState<Modification[]>([]);
  const [modsBtoA, setModsBtoA] = useState<Modification[]>([]);

  const canSubmit = name.trim() && projectId && initialMessage.trim();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    onCreate({
      name: name.trim(),
      projectId,
      modelSelection: { provider, model },
      runtimeMode,
      labelA,
      labelB,
      initialMessage: initialMessage.trim(),
      stopSignal,
      maxTurns,
      modificationsAtoB: modsAtoB,
      modificationsBtoA: modsBtoA,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <Wand2 className="size-5 text-zinc-400" />
            <h2 className="text-lg font-semibold text-zinc-100">
              Create Chat Pair
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
          >
            <X className="size-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6 p-6">
          {/* Basic Info */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Pair Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Code Review Loop"
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
                autoFocus
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Project
              </label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Runtime Mode
              </label>
              <select
                value={runtimeMode}
                onChange={(e) => setRuntimeMode(e.target.value as PairConfig["runtimeMode"])}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              >
                <option value="full-access">Full Access</option>
                <option value="auto-accept-edits">Auto-Accept Edits</option>
                <option value="approval-required">Approval Required</option>
              </select>
            </div>
          </div>

          {/* Model */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Provider
              </label>
              <select
                value={provider}
                onChange={(e) => {
                  const next = e.target.value as "claudeAgent" | "codex";
                  setProvider(next);
                  setModel(DEFAULT_MODELS[next]);
                }}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              >
                <option value="claudeAgent">Claude Agent</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Model
              </label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              >
                {MODELS_BY_PROVIDER[provider].map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Thread Labels */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-400">
                <span className="size-2 rounded-full bg-relay-a" />
                Thread A Label
              </label>
              <input
                type="text"
                value={labelA}
                onChange={(e) => setLabelA(e.target.value)}
                placeholder="Agent A"
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-400">
                <span className="size-2 rounded-full bg-relay-b" />
                Thread B Label
              </label>
              <input
                type="text"
                value={labelB}
                onChange={(e) => setLabelB(e.target.value)}
                placeholder="Agent B"
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              />
            </div>
          </div>

          {/* Initial Message */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Initial Message (sent to Thread A to start)
            </label>
            <textarea
              value={initialMessage}
              onChange={(e) => setInitialMessage(e.target.value)}
              placeholder="Write the opening prompt that kicks off the conversation..."
              rows={4}
              className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
            />
          </div>

          {/* Stop & Limits */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Stop Signal (regex)
              </label>
              <input
                type="text"
                value={stopSignal}
                onChange={(e) => setStopSignal(e.target.value)}
                placeholder="\\[STOP\\]"
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              />
              <p className="mt-1 text-xs text-zinc-600">
                If either agent's response matches this regex, the relay stops.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Max Turns (0 = unlimited)
              </label>
              <input
                type="number"
                value={maxTurns}
                onChange={(e) =>
                  setMaxTurns(Math.max(0, parseInt(e.target.value) || 0))
                }
                min={0}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              />
            </div>
          </div>

          {/* Modifications */}
          <div className="space-y-4 rounded-xl bg-zinc-800/30 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-300">
              <Wand2 className="size-4" />
              Message Modifications
            </div>

            <ModificationEditor
              label={
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-relay-a" />
                  {labelA || "A"}
                  <ArrowRight className="size-3" />
                  <span className="size-2 rounded-full bg-relay-b" />
                  {labelB || "B"}
                </span>
              }
              modifications={modsAtoB}
              onChange={setModsAtoB}
            />

            <div className="border-t border-zinc-700/50 pt-4">
              <ModificationEditor
                label={
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-relay-b" />
                    {labelB || "B"}
                    <ArrowRight className="size-3" />
                    <span className="size-2 rounded-full bg-relay-a" />
                    {labelA || "A"}
                  </span>
                }
                modifications={modsBtoA}
                onChange={setModsBtoA}
              />
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Create Pair
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
