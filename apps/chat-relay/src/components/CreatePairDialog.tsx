import { useState, useRef, type ReactNode } from "react";
import {
  Plus,
  X,
  ArrowRight,
  Wand2,
  Save,
  Upload,
  Download,
  Trash2,
  BookTemplate,
} from "lucide-react";
import type {
  ModelSelection,
  Modification,
  PairConfig,
  RelayTemplate,
  T3Project,
} from "../types";

interface Props {
  projects: T3Project[];
  templates: RelayTemplate[];
  onClose: () => void;
  onCreate: (config: PairConfig) => void;
  onSaveTemplate: (template: RelayTemplate) => void;
  onDeleteTemplate: (templateId: string) => void;
  onImportTemplates: (templates: RelayTemplate[]) => void;
}

// ─── Model config ───

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

// ─── Sub-components ───

function ModelSelector({
  label,
  provider,
  model,
  onProviderChange,
  onModelChange,
}: {
  label: ReactNode;
  provider: "claudeAgent" | "codex";
  model: string;
  onProviderChange: (p: "claudeAgent" | "codex") => void;
  onModelChange: (m: string) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-400">
          {label} Provider
        </label>
        <select
          value={provider}
          onChange={(e) => {
            const next = e.target.value as "claudeAgent" | "codex";
            onProviderChange(next);
            onModelChange(DEFAULT_MODELS[next]);
          }}
          className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-600"
        >
          <option value="claudeAgent">Claude Agent</option>
          <option value="codex">Codex</option>
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-zinc-400">
          {label} Model
        </label>
        <select
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
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
  );
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
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="block text-xs font-medium text-zinc-400">
          {label}
        </label>
        <button
          type="button"
          onClick={() =>
            onChange([...modifications, { type: "prefix", value: "" }])
          }
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
                  onChange(
                    modifications.map((m, j) =>
                      j === i
                        ? {
                            ...m,
                            type: e.target.value as Modification["type"],
                          }
                        : m,
                    ),
                  )
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
                      onChange(
                        modifications.map((m, j) =>
                          j === i ? { ...m, pattern: e.target.value } : m,
                        ),
                      )
                    }
                    placeholder="Regex pattern..."
                    className="w-full rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600"
                  />
                )}
                <textarea
                  value={mod.value}
                  onChange={(e) =>
                    onChange(
                      modifications.map((m, j) =>
                        j === i ? { ...m, value: e.target.value } : m,
                      ),
                    )
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
                onClick={() =>
                  onChange(modifications.filter((_, j) => j !== i))
                }
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

// ─── Main Dialog ───

export function CreatePairDialog({
  projects,
  templates,
  onClose,
  onCreate,
  onSaveTemplate,
  onDeleteTemplate,
  onImportTemplates,
}: Props) {
  const importRef = useRef<HTMLInputElement>(null);

  // Form state
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [providerA, setProviderA] = useState<"claudeAgent" | "codex">("claudeAgent");
  const [modelA, setModelA] = useState(DEFAULT_MODELS.claudeAgent);
  const [useSeparateModelB, setUseSeparateModelB] = useState(false);
  const [providerB, setProviderB] = useState<"claudeAgent" | "codex">("claudeAgent");
  const [modelB, setModelB] = useState(DEFAULT_MODELS.claudeAgent);
  const [runtimeMode, setRuntimeMode] = useState<PairConfig["runtimeMode"]>("full-access");
  const [labelA, setLabelA] = useState("Agent A");
  const [labelB, setLabelB] = useState("Agent B");
  const [initialMessage, setInitialMessage] = useState("");
  const [initialMessageB, setInitialMessageB] = useState("");
  const [stopSignal, setStopSignal] = useState("\\[STOP\\]");
  const [maxTurns, setMaxTurns] = useState(10);
  const [modsAtoB, setModsAtoB] = useState<Modification[]>([]);
  const [modsBtoA, setModsBtoA] = useState<Modification[]>([]);

  const canSubmit = name.trim() && projectId && initialMessage.trim();

  // ─── Load template into form ───
  function loadTemplate(template: RelayTemplate) {
    const c = template.config;
    setProviderA(c.modelSelection.provider);
    setModelA(c.modelSelection.model);
    if (c.modelSelectionB) {
      setUseSeparateModelB(true);
      setProviderB(c.modelSelectionB.provider);
      setModelB(c.modelSelectionB.model);
    } else {
      setUseSeparateModelB(false);
    }
    setRuntimeMode(c.runtimeMode);
    setLabelA(c.labelA);
    setLabelB(c.labelB);
    setInitialMessage(c.initialMessage);
    setInitialMessageB(c.initialMessageB ?? "");
    setStopSignal(c.stopSignal);
    setMaxTurns(c.maxTurns);
    setModsAtoB(c.modificationsAtoB);
    setModsBtoA(c.modificationsBtoA);
  }

  // ─── Save current form as template ───
  function saveAsTemplate() {
    const templateName = prompt("Template name:");
    if (!templateName?.trim()) return;

    const template: RelayTemplate = {
      id: crypto.randomUUID(),
      name: templateName.trim(),
      description: "",
      config: buildConfigWithoutProject(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    onSaveTemplate(template);
  }

  function buildConfigWithoutProject(): Omit<PairConfig, "name" | "projectId"> {
    return {
      modelSelection: { provider: providerA, model: modelA },
      ...(useSeparateModelB
        ? { modelSelectionB: { provider: providerB, model: modelB } }
        : {}),
      runtimeMode,
      initialMessage: initialMessage.trim(),
      initialMessageB: initialMessageB.trim(),
      labelA,
      labelB,
      stopSignal,
      maxTurns,
      modificationsAtoB: modsAtoB,
      modificationsBtoA: modsBtoA,
    };
  }

  // ─── Export / Import ───
  function exportTemplates() {
    const blob = new Blob([JSON.stringify(templates, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "relay-templates.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        if (Array.isArray(data)) {
          onImportTemplates(data);
        }
      } catch {
        alert("Invalid template file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const modelSelectionB: ModelSelection | undefined = useSeparateModelB
      ? { provider: providerB, model: modelB }
      : undefined;

    onCreate({
      name: name.trim(),
      projectId,
      modelSelection: { provider: providerA, model: modelA },
      ...(modelSelectionB ? { modelSelectionB } : {}),
      runtimeMode,
      labelA,
      labelB,
      initialMessage: initialMessage.trim(),
      initialMessageB: initialMessageB.trim(),
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
          {/* Templates */}
          {templates.length > 0 && (
            <div className="rounded-xl bg-zinc-800/30 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
                  <BookTemplate className="size-3.5" />
                  Templates
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={exportTemplates}
                    className="rounded p-1 text-zinc-600 transition hover:text-zinc-300"
                    title="Export all"
                  >
                    <Download className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => importRef.current?.click()}
                    className="rounded p-1 text-zinc-600 transition hover:text-zinc-300"
                    title="Import"
                  >
                    <Upload className="size-3.5" />
                  </button>
                  <input
                    ref={importRef}
                    type="file"
                    accept=".json"
                    onChange={handleImport}
                    className="hidden"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {templates.map((t) => (
                  <div key={t.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => loadTemplate(t)}
                      className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-zinc-700"
                    >
                      {t.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteTemplate(t.id)}
                      className="hidden rounded p-0.5 text-zinc-700 transition hover:text-red-400 group-hover:block"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No templates yet — show import/export buttons */}
          {templates.length === 0 && (
            <div className="flex items-center justify-between rounded-xl bg-zinc-800/20 px-3 py-2">
              <span className="text-xs text-zinc-600">No templates yet</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => importRef.current?.click()}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-500 transition hover:text-zinc-300"
                >
                  <Upload className="size-3" />
                  Import
                </button>
                <input
                  ref={importRef}
                  type="file"
                  accept=".json"
                  onChange={handleImport}
                  className="hidden"
                />
              </div>
            </div>
          )}

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
                onChange={(e) =>
                  setRuntimeMode(
                    e.target.value as PairConfig["runtimeMode"],
                  )
                }
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              >
                <option value="full-access">Full Access</option>
                <option value="auto-accept-edits">Auto-Accept Edits</option>
                <option value="approval-required">Approval Required</option>
              </select>
            </div>
          </div>

          {/* Thread Labels */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-400">
                <span className="size-2 rounded-full bg-relay-a" />
                Agent A Label
              </label>
              <input
                type="text"
                value={labelA}
                onChange={(e) => setLabelA(e.target.value)}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-400">
                <span className="size-2 rounded-full bg-relay-b" />
                Agent B Label
              </label>
              <input
                type="text"
                value={labelB}
                onChange={(e) => setLabelB(e.target.value)}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              />
            </div>
          </div>

          {/* Models */}
          <div className="space-y-3 rounded-xl bg-zinc-800/30 p-4">
            <ModelSelector
              label={
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-relay-a" />
                  Agent A
                </span>
              }
              provider={providerA}
              model={modelA}
              onProviderChange={setProviderA}
              onModelChange={setModelA}
            />

            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={useSeparateModelB}
                onChange={(e) => setUseSeparateModelB(e.target.checked)}
                className="rounded border-zinc-600"
              />
              Use a different model for Agent B
            </label>

            {useSeparateModelB && (
              <ModelSelector
                label={
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-full bg-relay-b" />
                    Agent B
                  </span>
                }
                provider={providerB}
                model={modelB}
                onProviderChange={setProviderB}
                onModelChange={setModelB}
              />
            )}
          </div>

          {/* Starting Prompts */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-400">
                <span className="size-2 rounded-full bg-relay-a" />
                Agent A — Starting Prompt
              </label>
              <textarea
                value={initialMessage}
                onChange={(e) => setInitialMessage(e.target.value)}
                placeholder="The first message sent to Agent A to kick things off..."
                rows={3}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              />
            </div>

            <div>
              <label className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-400">
                <span className="size-2 rounded-full bg-relay-b" />
                Agent B — Starting Prompt
                <span className="text-zinc-600">(optional)</span>
              </label>
              <textarea
                value={initialMessageB}
                onChange={(e) => setInitialMessageB(e.target.value)}
                placeholder={"Use {{response}} for Agent A's response.\ne.g.: You are reviewing code. Give thorough feedback:\n\n{{response}}"}
                rows={3}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              />
              <p className="mt-1 text-xs text-zinc-600">
                Template for Agent B's first message. Use{" "}
                <code className="rounded bg-zinc-800 px-1">{"{{response}}"}</code>{" "}
                where Agent A's response should go. If empty, A's response is sent directly.
              </p>
            </div>
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
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Max Turns (0 = unlimited)
              </label>
              <input
                type="number"
                value={maxTurns}
                onChange={(e) =>
                  setMaxTurns(
                    Math.max(0, parseInt(e.target.value) || 0),
                  )
                }
                min={0}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-600"
              />
            </div>
          </div>

          {/* Per-turn Modifications */}
          <div className="space-y-4 rounded-xl bg-zinc-800/30 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-300">
              <Wand2 className="size-4" />
              Per-Turn Modifications
            </div>
            <p className="text-xs text-zinc-600">
              Applied on every relay (after the first). Use these for recurring
              instructions like "Remember you're reviewing code, not implementing it."
            </p>

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

          {/* Actions */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={saveAsTemplate}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-400 transition hover:bg-zinc-700 hover:text-zinc-200"
            >
              <Save className="size-3.5" />
              Save as Template
            </button>

            <div className="flex gap-3">
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
          </div>
        </form>
      </div>
    </div>
  );
}
