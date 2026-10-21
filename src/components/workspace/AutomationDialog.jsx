"use client";

// AI-free automation: outbound webhooks, scheduled exports and rules.
// Owner-only; the server enforces the same.

import { useEffect, useState } from "react";
import {
  BellRing,
  CalendarClock,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import { toast, confirmDialog } from "./Feedback";

async function readError(res) {
  const data = await res.json().catch(() => ({}));
  return String(data.error || `HTTP ${res.status}`);
}

const TABS = [
  { id: "webhooks", label: "Webhooks", icon: Webhook },
  { id: "schedules", label: "Schedules", icon: CalendarClock },
  { id: "rules", label: "Rules", icon: Zap },
];

export default function AutomationDialog({ workspaceId, open, onClose }) {
  const [tab, setTab] = useState("webhooks");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hooks, setHooks] = useState([]);
  const [events, setEvents] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [rules, setRules] = useState([]);
  const [triggers, setTriggers] = useState([]);
  const [actions, setActions] = useState([]);

  const [hookUrl, setHookUrl] = useState("");
  const [hookEvents, setHookEvents] = useState(["file.updated"]);
  const [newSecret, setNewSecret] = useState("");
  const [intervalHours, setIntervalHours] = useState(24);
  const [ruleName, setRuleName] = useState("");
  const [ruleTrigger, setRuleTrigger] = useState("file.updated");
  const [ruleAction, setRuleAction] = useState("notify");
  const [ruleTarget, setRuleTarget] = useState("");
  const [openDeliveries, setOpenDeliveries] = useState("");
  const [deliveries, setDeliveries] = useState({});

  const call = async (method, path, body) => {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      toast(err.message, "error", 7000);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const base = `/api/workspaces/${workspaceId}`;
      const [h, s, r] = await Promise.all([
        fetch(`${base}/webhooks`).then((x) => (x.ok ? x.json() : { webhooks: [] })),
        fetch(`${base}/schedules`).then((x) => (x.ok ? x.json() : { schedules: [] })),
        fetch(`${base}/rules`).then((x) => (x.ok ? x.json() : { rules: [] })),
      ]);
      setHooks(h.webhooks || []);
      setEvents(h.events || []);
      setSchedules(s.schedules || []);
      setRules(r.rules || []);
      setTriggers(r.triggers || []);
      setActions(r.actions || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the one-time secret when reopening
    setNewSecret("");
    load();
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const toggleEvent = (ev) =>
    setHookEvents((s) => (s.includes(ev) ? s.filter((x) => x !== ev) : [...s, ev]));

  const addHook = async () => {
    if (!hookUrl.trim()) {
      toast("Enter a webhook URL", "error");
      return;
    }
    const data = await call("POST", `/api/workspaces/${workspaceId}/webhooks`, {
      url: hookUrl.trim(),
      events: hookEvents,
    });
    if (!data) return;
    setNewSecret(data.secret || "");
    setHookUrl("");
    toast("Webhook created — copy the signing secret now", "success", 8000);
    await load();
  };

  const removeHook = async (id) => {
    const ok = await confirmDialog({
      title: "Delete webhook?",
      message: "Pending deliveries for this webhook are removed too.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    if (await call("DELETE", `/api/workspaces/${workspaceId}/webhooks/${id}`)) await load();
  };

  const toggleHook = async (h) => {
    if (await call("PATCH", `/api/workspaces/${workspaceId}/webhooks/${h.id}`, { enabled: !h.enabled })) await load();
  };

  const showDeliveries = async (id) => {
    if (openDeliveries === id) {
      setOpenDeliveries("");
      return;
    }
    setOpenDeliveries(id);
    const data = await call("GET", `/api/workspaces/${workspaceId}/webhooks/${id}/deliveries?limit=25`);
    if (data) setDeliveries((d) => ({ ...d, [id]: data.deliveries || [] }));
  };

  const addSchedule = async () => {
    const data = await call("POST", `/api/workspaces/${workspaceId}/schedules`, {
      intervalHours: Number(intervalHours) || 24,
    });
    if (data) {
      toast("Scheduled export created", "success");
      await load();
    }
  };

  const toggleSchedule = async (s) => {
    if (await call("PATCH", `/api/workspaces/${workspaceId}/schedules/${s.id}`, { enabled: !s.enabled }))
      await load();
  };

  const removeSchedule = async (id) => {
    if (await call("DELETE", `/api/workspaces/${workspaceId}/schedules/${id}`)) await load();
  };

  const addRule = async () => {
    if (!ruleName.trim()) {
      toast("Give the rule a name", "error");
      return;
    }
    const config = ruleAction === "webhook" ? { url: ruleTarget.trim() } : { message: ruleTarget.trim() };
    const data = await call("POST", `/api/workspaces/${workspaceId}/rules`, {
      name: ruleName.trim(),
      trigger: ruleTrigger,
      action: ruleAction,
      config,
    });
    if (data) {
      setRuleName("");
      setRuleTarget("");
      toast("Rule created", "success");
      await load();
    }
  };

  const toggleRule = async (r) => {
    if (await call("PATCH", `/api/workspaces/${workspaceId}/rules/${r.id}`, { enabled: !r.enabled })) await load();
  };

  const removeRule = async (id) => {
    if (await call("DELETE", `/api/workspaces/${workspaceId}/rules/${id}`)) await load();
  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/65 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Automation"
        className="w-full max-w-xl max-h-[88vh] overflow-y-auto rounded-xl border border-[#43272e] bg-[#201317] shadow-2xl"
      >
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[#43272e] sticky top-0 bg-[#201317] z-10">
          <Zap size={18} className="text-[#f4a261]" />
          <div>
            <h2 className="text-sm font-semibold text-[#fbeeda]">Automation</h2>
            <p className="text-[11px] text-[#c3a596]">Webhooks, scheduled exports and simple rules.</p>
          </div>
          <button
            className="ml-auto p-1.5 rounded-md text-[#a1847a] hover:text-white hover:bg-[#332026]"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-1 px-5 pt-3">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${
                tab === id ? "bg-[#332026] text-[#fbeeda]" : "text-[#a1847a] hover:text-[#fbeeda]"
              }`}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
          <button className="ml-auto p-1.5 rounded text-[#a1847a] hover:text-white" onClick={load} title="Refresh">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        </div>

        <div className="p-5 space-y-4">
          {tab === "webhooks" && (
            <>
              <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3 space-y-2">
                <input
                  className="field w-full font-mono text-xs"
                  placeholder="https://example.com/hooks/iw"
                  value={hookUrl}
                  onChange={(e) => setHookUrl(e.target.value)}
                  spellCheck={false}
                />
                <div className="flex flex-wrap gap-1.5">
                  {events.map((ev) => (
                    <button
                      key={ev}
                      onClick={() => toggleEvent(ev)}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-mono border ${
                        hookEvents.includes(ev)
                          ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
                          : "border-[#43272e] text-[#a1847a] hover:text-white"
                      }`}
                    >
                      {ev}
                    </button>
                  ))}
                </div>
                <button className="btn btn-primary px-3 py-1.5" onClick={addHook} disabled={busy}>
                  <Plus size={13} /> Add webhook
                </button>
                {newSecret && (
                  <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
                    <p className="text-[10px] text-amber-200 mb-1">
                      Signing secret (shown once — store it now):
                    </p>
                    <code className="block break-all text-[10px] text-amber-100 font-mono">{newSecret}</code>
                  </div>
                )}
              </div>

              {hooks.length === 0 && (
                <p className="text-xs text-[#a1847a]">No webhooks yet. Requests are signed with the secret.</p>
              )}

              <div className="space-y-2">
                {hooks.map((h) => (
                  <div key={h.id} className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <span
                        className={`mt-1 h-2 w-2 flex-none rounded-full ${
                          h.enabled ? "bg-emerald-400" : "bg-stone-500"
                        }`}
                      />
                      <code className="min-w-0 flex-1 break-all text-[11px] text-[#fbeeda]">{h.url}</code>
                      <button
                        className="p-1 rounded text-[#a1847a] hover:text-white"
                        onClick={() => toggleHook(h)}
                        title={h.enabled ? "Disable" : "Enable"}
                        disabled={busy}
                      >
                        <BellRing size={13} />
                      </button>
                      <button
                        className="p-1 rounded text-[#a1847a] hover:text-red-400"
                        onClick={() => removeHook(h.id)}
                        title="Delete"
                        disabled={busy}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#a1847a]">
                      <span className="font-mono">{h.events}</span>
                      <span className="text-emerald-400">{h.stats.delivered} sent</span>
                      {h.stats.failed > 0 && <span className="text-red-400">{h.stats.failed} failed</span>}
                      {h.stats.pending > 0 && <span className="text-amber-400">{h.stats.pending} pending</span>}
                      <button
                        className="ml-auto inline-flex items-center gap-1 hover:text-white"
                        onClick={() => showDeliveries(h.id)}
                      >
                        <ChevronDown size={11} /> Deliveries
                      </button>
                    </div>
                    {openDeliveries === h.id && (
                      <div className="space-y-1 border-t border-[#43272e] pt-2">
                        {(deliveries[h.id] || []).length === 0 && (
                          <p className="text-[10px] text-[#a1847a]">No deliveries recorded yet.</p>
                        )}
                        {(deliveries[h.id] || []).map((d) => (
                          <div key={d.id} className="flex items-center gap-2 text-[10px]">
                            <span className="font-mono text-[#c3a596]">{d.event}</span>
                            <span
                              className={
                                d.status === "delivered"
                                  ? "text-emerald-400"
                                  : d.status === "failed"
                                    ? "text-red-400"
                                    : "text-amber-400"
                              }
                            >
                              {d.status}
                            </span>
                            {d.lastStatus && <span className="text-[#a1847a]">HTTP {d.lastStatus}</span>}
                            {d.lastError && <span className="truncate text-red-300/80">{d.lastError}</span>}
                            <span className="ml-auto text-[#7a5a52]">
                              {new Date(d.createdAt).toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "schedules" && (
            <>
              <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3 space-y-2">
                <p className="text-[11px] text-[#c3a596]">
                  Periodically snapshot this workspace as a JSON bundle stored on the server.
                </p>
                <div className="flex items-center gap-2">
                  <select
                    className="field w-40"
                    value={intervalHours}
                    onChange={(e) => setIntervalHours(e.target.value)}
                  >
                    <option value={6}>Every 6 hours</option>
                    <option value={12}>Every 12 hours</option>
                    <option value={24}>Daily</option>
                    <option value={168}>Weekly</option>
                  </select>
                  <button className="btn btn-primary px-3 py-1.5" onClick={addSchedule} disabled={busy}>
                    <Plus size={13} /> Add schedule
                  </button>
                </div>
              </div>
              {schedules.length === 0 && <p className="text-xs text-[#a1847a]">No scheduled exports yet.</p>}
              <div className="space-y-2">
                {schedules.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-2 rounded-lg border border-[#43272e] bg-[#2a181d] px-3 py-2 text-[11px]"
                  >
                    <CalendarClock size={13} className="text-[#f4a261]" />
                    <span className="text-[#fbeeda]">{s.kind}</span>
                    <span className="text-[#a1847a]">every {Math.round(s.intervalMs / 3600000)}h</span>
                    <span className="text-[#a1847a]">next {new Date(s.nextRunAt).toLocaleString()}</span>
                    {s.lastError && <span className="truncate text-red-400">{s.lastError}</span>}
                    <button
                      className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${
                        s.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-stone-500/15 text-stone-400"
                      }`}
                      onClick={() => toggleSchedule(s)}
                      disabled={busy}
                    >
                      {s.enabled ? "enabled" : "paused"}
                    </button>
                    <button
                      className="p-1 rounded text-[#a1847a] hover:text-red-400"
                      onClick={() => removeSchedule(s.id)}
                      disabled={busy}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "rules" && (
            <>
              <div className="rounded-lg border border-[#43272e] bg-[#2a181d] p-3 space-y-2">
                <input
                  className="field w-full"
                  placeholder="Rule name — e.g. Notify on new files"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  maxLength={120}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <select className="field w-44" value={ruleTrigger} onChange={(e) => setRuleTrigger(e.target.value)}>
                    {(triggers.length ? triggers : [ruleTrigger]).map((t) => (
                      <option key={t} value={t}>
                        when {t}
                      </option>
                    ))}
                  </select>
                  <select className="field w-36" value={ruleAction} onChange={(e) => setRuleAction(e.target.value)}>
                    {(actions.length ? actions : [ruleAction]).map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  className="field w-full"
                  placeholder={ruleAction === "webhook" ? "https://example.com/hooks/rule" : "Notification message"}
                  value={ruleTarget}
                  onChange={(e) => setRuleTarget(e.target.value)}
                  spellCheck={false}
                />
                <button className="btn btn-primary px-3 py-1.5" onClick={addRule} disabled={busy}>
                  <Plus size={13} /> Add rule
                </button>
              </div>
              {rules.length === 0 && <p className="text-xs text-[#a1847a]">No rules yet.</p>}
              <div className="space-y-2">
                {rules.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-2 rounded-lg border border-[#43272e] bg-[#2a181d] px-3 py-2 text-[11px]"
                  >
                    <Zap size={13} className={r.enabled ? "text-amber-400" : "text-stone-500"} />
                    <span className="min-w-0 truncate text-[#fbeeda]">{r.name || "(unnamed)"}</span>
                    <span className="font-mono text-[10px] text-[#a1847a]">
                      {r.trigger} → {r.action}
                    </span>
                    <button
                      className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${
                        r.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-stone-500/15 text-stone-400"
                      }`}
                      onClick={() => toggleRule(r)}
                      disabled={busy}
                    >
                      {r.enabled ? "enabled" : "paused"}
                    </button>
                    <button
                      className="p-1 rounded text-[#a1847a] hover:text-red-400"
                      onClick={() => removeRule(r.id)}
                      disabled={busy}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
