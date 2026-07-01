import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  LayoutDashboard, Target, Activity, LogOut, Lock,
  Plus, Delete, X, Check, Trash2, ChevronRight, ChevronDown, CornerDownRight, Pencil, Eye, EyeOff, Menu
} from "lucide-react";
import { supabase, supabaseConfigured } from "./supabaseClient";

// Tracks whether we're on a narrow (phone/tablet) screen so layout can adapt.
function useIsMobile(breakpoint = 820) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

/*
  Life Tracker
  ============
  Goal tree: customizable categories (defaults: Religious, Health, Language
  Learning, Job). Each category holds goals; goals hold sub-goals (branches),
  nested arbitrarily deep. Categories and goals can be added, renamed, reordered,
  and deleted. Daily loop: mark a goal "done today"; every mark is a dated
  completion. Consistency = days recorded / expected days over the goal's
  lifetime, where expected comes from the goal's cadence (daily / N per week).
  A parent's consistency rolls up as the average of its leaf descendants.
  Expenses carry a category; you see monthly and yearly totals (in EUR) and a
  per-category breakdown. Year-end summary reports consistency for every goal.

  Locked behind a user-chosen email/password account (Supabase).

  PERSISTENCE: all state is saved to Supabase (one JSON row per user), so goals,
  completions, expenses, and categories sync across devices and stay private.

  GOAL MODEL: each goal has a cadence (daily, or N per week) and a duration that
  is either "ongoing" or finite ("until" a date). Consistency counts from the
  goal's FIRST TICK (the day you actually started doing it), not its creation
  date — a goal you've created but never ticked hasn't "started" yet.
*/

// ---------- date helpers ------------------------------------------------------

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const today = () => new Date().toISOString().slice(0, 10);
function daysBetween(aISO, bISO) {
  return Math.max(0, Math.round((new Date(bISO) - new Date(aISO)) / 86400000));
}
// today's date plus n months, as an ISO yyyy-mm-dd string (for end-period presets).
function addMonthsISO(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

// The day a goal actually started: its earliest completion date. Null if never ticked.
function firstTick(goal, completions) {
  const dates = completions.filter((c) => c.goalId === goal.id).map((c) => c.date).sort();
  return dates.length ? dates[0] : null;
}
// The window consistency is measured over: from first tick to today, OR to the
// goal's end date if it's finite and already ended. Returns null if not started.
function goalWindow(goal, completions) {
  const start = firstTick(goal, completions);
  if (!start) return null;
  let end = today();
  if (goal.duration === "until" && goal.endDate && goal.endDate < end) end = goal.endDate; // finished goal: freeze at end
  return { start, end };
}
// Expected number of recorded days across the window, given the cadence.
function expectedDays(goal, completions) {
  const w = goalWindow(goal, completions);
  if (!w) return 0;
  const days = daysBetween(w.start, w.end) + 1;
  if (goal.cadence === "daily") return days;
  return Math.max(1, Math.round((days / 7) * goal.perWeek));
}

const WEEK_LABELS = { 1: "Once a week", 2: "Twice a week", 3: "Three times a week", 4: "Four times a week", 5: "Five times a week", 6: "Six times a week" };
function cadenceLabel(goal) {
  const base = goal.cadence === "daily" ? "Daily" : (WEEK_LABELS[goal.perWeek] || `${goal.perWeek}× / week`);
  if (goal.duration === "until" && goal.endDate) return `${base} · until ${goal.endDate}`;
  return base;
}

// ---------- store -------------------------------------------------------------

const DEFAULT_CATEGORIES = ["Religious", "Health", "Language Learning", "Job"];
const DEFAULT_EXPENSE_CATEGORIES = ["Groceries", "Rent", "Bills", "Transport", "Health", "Other"];

const SEED_GOALS = [
  { id: 1, category: "Health", parentId: null, title: "Go to the gym", cadence: "week", perWeek: 4, duration: "ongoing", endDate: null, createdAt: today() },
];

// The store persists the whole tracker state as one JSON row per user in
// Supabase (table: tracker_state). It loads that row on login and saves it,
// debounced, on every change. Row-level security keeps each user's row private.
function useStore(userId) {
  const idRef = useRef(100); // stable across strict-mode double-invoke
  const nid = useCallback(() => ++idRef.current, []);

  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [expenseCats, setExpenseCats] = useState(DEFAULT_EXPENSE_CATEGORIES);
  const [goals, setGoals] = useState(SEED_GOALS);
  const [completions, setCompletions] = useState([]); // {id, goalId, date}
  const [expenses, setExpenses] = useState([]);        // {id, label, amount, category, date}
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef(null);

  // Load this user's row once (per login). New users get defaults until first save.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setLoaded(false);
    (async () => {
      try {
        const { data, error } = await supabase
          .from("tracker_state").select("state").eq("user_id", userId).maybeSingle();
        if (!error && alive && data?.state) {
          const s = data.state;
          setCategories(s.categories ?? DEFAULT_CATEGORIES);
          setExpenseCats(s.expenseCats ?? DEFAULT_EXPENSE_CATEGORIES);
          setGoals(s.goals ?? SEED_GOALS);
          setCompletions(s.completions ?? []);
          setExpenses(s.expenses ?? []);
          idRef.current = s.nextId ?? 100;
        }
      } catch { /* keep defaults */ }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
  }, [userId]);

  // Debounced upsert on change (after load), so rapid edits batch into one write.
  useEffect(() => {
    if (!loaded || !userId) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      supabase.from("tracker_state").upsert({
        user_id: userId,
        state: { categories, expenseCats, goals, completions, expenses, nextId: idRef.current },
        updated_at: new Date().toISOString(),
      }).then(({ error }) => { if (error) console.error("save failed", error); });
    }, 600);
    return () => clearTimeout(saveTimer.current);
  }, [loaded, userId, categories, expenseCats, goals, completions, expenses]);

  const addCategory = (name) => {
    const n = name.trim();
    if (n && !categories.includes(n)) setCategories((p) => [...p, n]);
  };
  const deleteCategory = (name) => {
    const removedIds = new Set(goals.filter((g) => g.category === name).map((g) => g.id));
    setCategories((p) => p.filter((c) => c !== name));
    setGoals((p) => p.filter((g) => g.category !== name));
    setCompletions((cs) => cs.filter((c) => !removedIds.has(c.goalId)));
  };
  const moveCategory = (name, dir) => setCategories((p) => {
    const i = p.indexOf(name), j = i + dir;
    if (i < 0 || j < 0 || j >= p.length) return p;
    const next = [...p]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const renameCategory = (oldName, newName) => {
    const n = newName.trim();
    if (!n || n === oldName || categories.includes(n)) return;
    setCategories((p) => p.map((c) => (c === oldName ? n : c)));
    setGoals((p) => p.map((g) => (g.category === oldName ? { ...g, category: n } : g)));
  };

  // expense categories — editable like goal categories
  const addExpenseCat = (name) => {
    const n = name.trim();
    if (n && !expenseCats.includes(n)) setExpenseCats((p) => [...p, n]);
  };
  const deleteExpenseCat = (name) => setExpenseCats((p) => p.filter((c) => c !== name));

  const addGoal = (g) => setGoals((p) => [...p, { ...g, id: nid(), createdAt: today() }]);

  // Cascade delete: compute the full subtree first (pure), then update each
  // state slice with its own top-level setter. No setter is nested inside another.
  const deleteGoal = (goalId) => {
    setGoals((prev) => {
      const toRemove = new Set([goalId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const g of prev) {
          if (g.parentId != null && toRemove.has(g.parentId) && !toRemove.has(g.id)) {
            toRemove.add(g.id); grew = true;
          }
        }
      }
      setCompletions((cs) => cs.filter((c) => !toRemove.has(c.goalId)));
      return prev.filter((g) => !toRemove.has(g.id));
    });
  };

  const tickToday = (goalId) => setCompletions((p) =>
    p.some((c) => c.goalId === goalId && c.date === today())
      ? p : [...p, { id: nid(), goalId, date: today() }]);
  const untickToday = (goalId) => setCompletions((p) =>
    p.filter((c) => !(c.goalId === goalId && c.date === today())));

  const addExpense = (e) => setExpenses((p) => [...p, { ...e, id: nid() }]);
  const deleteExpense = (id) => setExpenses((p) => p.filter((e) => e.id !== id));

  return {
    loaded, categories, expenseCats, goals, completions, expenses,
    addCategory, deleteCategory, moveCategory, renameCategory,
    addExpenseCat, deleteExpenseCat,
    addGoal, deleteGoal, tickToday, untickToday, addExpense, deleteExpense,
  };
}

// ---------- consistency math --------------------------------------------------

function isLeaf(goal, goals) { return !goals.some((g) => g.parentId === goal.id); }

function leafConsistency(goal, completions) {
  const w = goalWindow(goal, completions);
  if (!w) return 0; // not started yet
  const done = completions.filter((c) => c.goalId === goal.id && c.date >= w.start && c.date <= w.end).length;
  const expected = expectedDays(goal, completions);
  return expected ? Math.min(100, Math.round((done / expected) * 100)) : 0;
}
// True once a finite goal's end date has passed.
function isFinished(goal) {
  return goal.duration === "until" && goal.endDate && goal.endDate < today();
}

// parent rolls up as average of its leaf descendants
function goalConsistency(goal, goals, completions) {
  if (isLeaf(goal, goals)) return leafConsistency(goal, completions);
  const leaves = [];
  const collect = (id) => {
    for (const g of goals) if (g.parentId === id) {
      if (isLeaf(g, goals)) leaves.push(g); else collect(g.id);
    }
  };
  collect(goal.id);
  if (!leaves.length) return 0;
  return Math.round(leaves.reduce((s, l) => s + leafConsistency(l, completions), 0) / leaves.length);
}

// ---------- theme -------------------------------------------------------------

const C = {
  bg: "#FAF8F2", panel: "#FFFFFF", ink: "#1C2B22", green: "#28402F",
  greenSoft: "#3C5A45", gold: "#C49A4A", muted: "#8A8576", line: "#ECE8DD",
};
const CAT_COLOR_MAP = {
  "Religious": "#7A6FB0", "Health": "#3C8C6A",
  "Language Learning": "#C49A4A", "Job": "#4A7BA6",
};
const CUSTOM_PALETTE = ["#B4694A", "#5A8C7B", "#9A6FB0", "#C4884A", "#4A8CA6", "#8C6A5A", "#6A8C4A"];
function catColor(name) {
  if (CAT_COLOR_MAP[name]) return CAT_COLOR_MAP[name];
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CUSTOM_PALETTE[h % CUSTOM_PALETTE.length];
}

// ============================ AUTH SCREEN =====================================

function AuthScreen() {
  const [mode, setMode] = useState("signin"); // signin | signup | reset
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function submit() {
    setMsg("");
    if (mode === "reset") {
      if (!email.trim()) { setMsg("Enter your email and we'll send a reset link."); return; }
      setBusy(true);
      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: window.location.origin,
        });
        // Always show the same message whether or not the email exists, so we
        // don't reveal which addresses have accounts.
        setMsg(error ? error.message : "If that email has an account, a reset link is on its way. Check your inbox.");
      } catch { setMsg("Something went wrong. Try again."); }
      setBusy(false);
      return;
    }

    if (!email.trim() || password.length < 6) {
      setMsg("Enter an email and a password of at least 6 characters."); return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) setMsg(error.message);
        else setMsg("Account created. If email confirmation is on, check your inbox, then sign in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) setMsg(error.message);
        // on success, App's auth listener swaps to the app automatically
      }
    } catch (e) {
      setMsg("Something went wrong. Try again.");
    }
    setBusy(false);
  }

  const subtitle = mode === "signin" ? "Sign in to your tracker."
    : mode === "signup" ? "Create your account."
    : "Reset your password.";

  return (
    <div style={{ minHeight: "100%", background: C.green, color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 340 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ display: "inline-flex", padding: 16, borderRadius: 20,
            background: "rgba(255,255,255,0.08)", marginBottom: 20 }}><Lock size={28} color={C.gold} /></div>
          <h1 style={{ fontFamily: "Georgia, serif", fontSize: 28, margin: "0 0 6px" }}>Life Tracker</h1>
          <p style={{ color: "rgba(255,255,255,0.6)", margin: "0 0 28px", fontSize: 14 }}>{subtitle}</p>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="Email" autoComplete="email" style={authInput}
            onKeyDown={(e) => e.key === "Enter" && submit()} />

          {mode !== "reset" && (
            <div style={{ position: "relative" }}>
              <input type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Password" autoComplete={mode === "signup" ? "new-password" : "current-password"}
                style={{ ...authInput, paddingRight: 44 }} onKeyDown={(e) => e.key === "Enter" && submit()} />
              <button type="button" onClick={() => setShowPw((s) => !s)}
                aria-label={showPw ? "Hide password" : "Show password"}
                style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.6)",
                  display: "flex", padding: 6 }}>
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          )}

          <button onClick={submit} disabled={busy}
            style={{ ...authInput, background: C.gold, color: C.green, fontWeight: 700, cursor: "pointer", border: "none" }}>
            {busy ? "…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Sign up" : "Send reset link"}
          </button>
        </div>

        {msg && <p style={{ ...hint, textAlign: "center" }}>{msg}</p>}

        {mode === "signin" && (
          <p style={{ textAlign: "center", marginTop: 14, fontSize: 13 }}>
            <button onClick={() => { setMode("reset"); setMsg(""); }}
              style={{ background: "none", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 13 }}>
              Forgot password?
            </button>
          </p>
        )}

        <p style={{ textAlign: "center", marginTop: mode === "signin" ? 4 : 18, fontSize: 14 }}>
          {mode === "reset" ? (
            <button onClick={() => { setMode("signin"); setMsg(""); }}
              style={{ background: "none", border: "none", color: C.gold, cursor: "pointer", fontSize: 14 }}>
              Back to sign in
            </button>
          ) : (
            <button onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setMsg(""); }}
              style={{ background: "none", border: "none", color: C.gold, cursor: "pointer", fontSize: 14 }}>
              {mode === "signin" ? "No account? Sign up" : "Have an account? Sign in"}
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

// Shown when the user clicks the reset link in their email.
function NewPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function save() {
    if (password.length < 6) { setMsg("Password must be at least 6 characters."); return; }
    setBusy(true); setMsg("");
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setMsg(error.message);
    else { setMsg("Password updated. Taking you in…"); setTimeout(onDone, 800); }
  }

  return (
    <div style={{ minHeight: "100%", background: C.green, color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 340 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ display: "inline-flex", padding: 16, borderRadius: 20,
            background: "rgba(255,255,255,0.08)", marginBottom: 20 }}><Lock size={28} color={C.gold} /></div>
          <h1 style={{ fontFamily: "Georgia, serif", fontSize: 28, margin: "0 0 6px" }}>Set a new password</h1>
          <p style={{ color: "rgba(255,255,255,0.6)", margin: "0 0 28px", fontSize: 14 }}>Choose a new password for your account.</p>
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ position: "relative" }}>
            <input type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="New password" autoComplete="new-password"
              style={{ ...authInput, paddingRight: 44 }} onKeyDown={(e) => e.key === "Enter" && save()} />
            <button type="button" onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? "Hide password" : "Show password"}
              style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.6)", display: "flex", padding: 6 }}>
              {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <button onClick={save} disabled={busy}
            style={{ ...authInput, background: C.gold, color: C.green, fontWeight: 700, cursor: "pointer", border: "none" }}>
            {busy ? "…" : "Update password"}
          </button>
        </div>
        {msg && <p style={{ ...hint, textAlign: "center" }}>{msg}</p>}
      </div>
    </div>
  );
}

// Shown when the app hasn't been pointed at a Supabase project yet.
function NeedsConfig() {
  return (
    <div style={{ minHeight: "100%", background: C.green, color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 460, lineHeight: 1.6 }}>
        <h1 style={{ fontFamily: "Georgia, serif", fontSize: 26 }}>Almost there</h1>
        <p style={{ color: "rgba(255,255,255,0.8)" }}>
          This app needs a Supabase project. Add your project URL and anon key to a
          <code style={{ background: "rgba(255,255,255,0.12)", padding: "1px 5px", borderRadius: 4 }}> .env</code> file
          (see <code style={{ background: "rgba(255,255,255,0.12)", padding: "1px 5px", borderRadius: 4 }}>.env.example</code>)
          and run the SQL in <code style={{ background: "rgba(255,255,255,0.12)", padding: "1px 5px", borderRadius: 4 }}>supabase-setup.sql</code>.
          The README has step-by-step instructions.
        </p>
      </div>
    </div>
  );
}

const authInput = { width: "100%", padding: "13px 14px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(255,255,255,0.06)", color: "#fff", fontSize: 15, outline: "none" };
const hint = { color: "rgba(255,255,255,0.65)", fontSize: 13, margin: "14px 0 0" };

// ============================ APP =============================================

const NAV = [
  { id: "today", label: "Today", icon: LayoutDashboard },
  { id: "goals", label: "Goals", icon: Target },
  { id: "insights", label: "Insights", icon: Activity },
];

export default function App() {
  const [page, setPage] = useState("today");
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const userId = session?.user?.id ?? null;
  const store = useStore(userId);

  // Track the auth session: check once on load, then listen for changes.
  useEffect(() => {
    if (!supabaseConfigured) { setAuthChecked(true); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Arriving via a password-reset email: show the "set new password" screen.
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!supabaseConfigured) return (
    <div style={{ height: "100vh", fontFamily: "system-ui, sans-serif" }}><NeedsConfig /></div>
  );

  if (!authChecked) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: C.green, color: "rgba(255,255,255,0.6)", fontFamily: "system-ui, sans-serif" }}>Loading…</div>
  );

  if (recovering) return (
    <div style={{ height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <NewPasswordScreen onDone={() => setRecovering(false)} />
    </div>
  );

  if (!session) return (
    <div style={{ height: "100vh", fontFamily: "system-ui, sans-serif" }}><AuthScreen /></div>
  );

  if (!store.loaded) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: C.green, color: "rgba(255,255,255,0.6)", fontFamily: "system-ui, sans-serif" }}>Loading your data…</div>
  );

  return <AppShell page={page} setPage={setPage} store={store} email={session.user.email} />;
}

function AppShell({ page, setPage, store, email }) {
  const isMobile = useIsMobile();
  return (
    <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", height: "100vh",
      background: C.bg, color: C.ink, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <Sidebar page={page} setPage={setPage} onSignOut={() => supabase.auth.signOut()} email={email} isMobile={isMobile} />
      <main style={{ flex: 1, overflowY: "auto", padding: isMobile ? "20px 16px 40px" : "32px 40px" }}>
        {page === "today" && <Today store={store} />}
        {page === "goals" && <Goals store={store} />}
        {page === "insights" && <Insights store={store} />}
      </main>
    </div>
  );
}

function Sidebar({ page, setPage, onSignOut, email, isMobile }) {
  const [open, setOpen] = useState(false);

  if (isMobile) {
    // Top bar with a hamburger that opens a dropdown menu.
    return (
      <header style={{ background: C.panel, borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px" }}>
          <h2 style={{ fontFamily: "Georgia, serif", fontSize: 20, margin: 0 }}>Life Tracker</h2>
          <button onClick={() => setOpen((o) => !o)} aria-label="Menu"
            style={{ background: "none", border: "none", cursor: "pointer", color: C.ink, padding: 6 }}>
            {open ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
        {open && (
          <nav style={{ borderTop: `1px solid ${C.line}`, padding: 8 }}>
            {NAV.map(({ id, label, icon: Icon }) => {
              const active = page === id;
              return (
                <button key={id} onClick={() => { setPage(id); setOpen(false); }}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", borderRadius: 10, width: "100%",
                    border: "none", cursor: "pointer", textAlign: "left", fontSize: 16, fontWeight: active ? 600 : 500,
                    background: active ? C.green : "transparent", color: active ? "#fff" : C.muted }}>
                  <Icon size={18} /> {label}
                </button>
              );
            })}
            {email && <div style={{ padding: "10px 14px 4px", fontSize: 12, color: C.muted }}>{email}</div>}
            <button onClick={onSignOut} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", borderRadius: 10, width: "100%", border: "none", cursor: "pointer", background: "transparent", color: C.muted, fontSize: 16 }}>
              <LogOut size={18} /> Sign out
            </button>
          </nav>
        )}
      </header>
    );
  }

  return (
    <aside style={{ width: 240, background: C.panel, borderRight: `1px solid ${C.line}`, display: "flex", flexDirection: "column", padding: "24px 16px" }}>
      <h2 style={{ fontFamily: "Georgia, serif", fontSize: 22, margin: "0 12px 28px" }}>Life Tracker</h2>
      <nav style={{ display: "grid", gap: 4, flex: 1 }}>
        {NAV.map(({ id, label, icon: Icon }) => {
          const active = page === id;
          return (
            <button key={id} onClick={() => setPage(id)}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderRadius: 10,
                border: "none", cursor: "pointer", textAlign: "left", fontSize: 15, fontWeight: active ? 600 : 500,
                background: active ? C.green : "transparent", color: active ? "#fff" : C.muted }}>
              <Icon size={18} /> {label}
            </button>
          );
        })}
      </nav>
      {email && <div style={{ padding: "0 14px 8px", fontSize: 12, color: C.muted, overflow: "hidden", textOverflow: "ellipsis" }}>{email}</div>}
      <button onClick={onSignOut} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderRadius: 10, border: "none", cursor: "pointer", background: "transparent", color: C.muted, fontSize: 15 }}>
        <LogOut size={18} /> Sign out
      </button>
    </aside>
  );
}

// ---------- shared bits -------------------------------------------------------

function Card({ children, style }) {
  return <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 22, ...style }}>{children}</div>;
}
function Eyebrow({ children, color }) {
  return <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: color || C.muted, fontWeight: 600, marginBottom: 8 }}>{children}</div>;
}
function PageTitle({ kicker, title }) {
  return <div style={{ marginBottom: 28 }}>{kicker && <Eyebrow>{kicker}</Eyebrow>}<h1 style={{ fontFamily: "Georgia, serif", fontSize: 30, margin: 0 }}>{title}</h1></div>;
}
function Bar({ value, color = C.green }) {
  return <div style={{ height: 6, borderRadius: 99, background: C.line, overflow: "hidden", marginTop: 10 }}>
    <div style={{ height: "100%", width: `${Math.min(100, value)}%`, background: color, borderRadius: 99 }} /></div>;
}
// Circular progress ring for the at-a-glance headline metrics.
function Ring({ value, label, sub, color = C.green, size = 96 }) {
  const stroke = 8, r = (size - stroke) / 2, circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.line} strokeWidth={stroke} />
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
            strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - pct / 100)} />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "Georgia, serif", fontSize: 20, fontWeight: 700 }}>{Math.round(pct)}%</div>
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: C.muted }}>{sub}</div>}
      </div>
    </div>
  );
}
const inputStyle = { flex: 1, padding: "11px 14px", borderRadius: 10, border: `1px solid ${C.line}`, fontSize: 15, outline: "none", background: C.bg, color: C.ink };
const primaryBtn = { display: "flex", alignItems: "center", gap: 6, padding: "11px 18px", borderRadius: 10, border: "none", background: C.green, color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer" };

// ---------- TODAY (the daily ticking loop) ------------------------------------

function Today({ store }) {
  const now = new Date();
  const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";
  const leaves = store.goals.filter((g) => isLeaf(g, store.goals));
  const tickedToday = (id) => store.completions.some((c) => c.goalId === id && c.date === today());
  const doneCount = leaves.filter((g) => tickedToday(g.id)).length;

  // money logging
  const cats = store.expenseCats;
  const [spendCat, setSpendCat] = useState(cats[0] || "Other");
  const [amount, setAmount] = useState("");
  const [newCat, setNewCat] = useState("");
  const [showCats, setShowCats] = useState(false);
  const todaysExpenses = store.expenses.filter((e) => e.date === today());
  const todaysSpend = todaysExpenses.reduce((s, e) => s + e.amount, 0);

  const logSpend = () => {
    const a = parseFloat(amount);
    if (a > 0) { store.addExpense({ label: spendCat, amount: a, category: spendCat, date: today() }); setAmount(""); }
  };
  const addCat = () => { const n = newCat.trim(); if (n) { store.addExpenseCat(n); setSpendCat(n); setNewCat(""); } };

  return (
    <div>
      <Eyebrow>{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</Eyebrow>
      <h1 style={{ fontFamily: "Georgia, serif", fontSize: 34, margin: "2px 0 6px" }}>{greeting}</h1>
      <p style={{ color: C.muted, margin: "0 0 28px" }}>{doneCount} of {leaves.length} goals marked done today.</p>

      {store.categories.map((cat) => {
        const catLeaves = leaves.filter((g) => g.category === cat);
        if (!catLeaves.length) return null;
        return (
          <div key={cat} style={{ marginBottom: 20 }}>
            <Eyebrow color={catColor(cat)}>{cat}</Eyebrow>
            <div style={{ display: "grid", gap: 10 }}>
              {catLeaves.map((g) => {
                const on = tickedToday(g.id);
                return (
                  <Card key={g.id} style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 14,
                    borderLeft: `4px solid ${catColor(cat)}` }}>
                    <button onClick={() => on ? store.untickToday(g.id) : store.tickToday(g.id)}
                      style={{ width: 28, height: 28, borderRadius: "50%", cursor: "pointer",
                        border: `2px solid ${on ? catColor(cat) : C.line}`, background: on ? catColor(cat) : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {on && <Check size={15} color="#fff" />}
                    </button>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{g.title}</div>
                      <div style={{ fontSize: 13, color: C.muted }}>
                        {cadenceLabel(g)} · {store.completions.filter((c) => c.goalId === g.id).length} days · {leafConsistency(g, store.completions)}% consistent
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        );
      })}
      {leaves.length === 0 && <Card style={{ marginBottom: 20 }}><p style={{ color: C.muted, margin: 0 }}>No goals yet. Add some on the Goals page, then tick them here each day.</p></Card>}

      {/* MONEY — log today's spending right here */}
      <Eyebrow color={C.gold}>Money spent today</Eyebrow>
      <Card style={{ borderLeft: `4px solid ${C.gold}` }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <select value={spendCat} onChange={(e) => setSpendCat(e.target.value)} style={{ ...inputStyle, flex: "none", width: 160 }}>
            {cats.map((c) => <option key={c}>{c}</option>)}
          </select>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (€)"
            style={{ ...inputStyle, flex: "none", width: 140 }} onKeyDown={(e) => e.key === "Enter" && logSpend()} />
          <button onClick={logSpend} style={{ ...primaryBtn, background: C.gold, color: C.green }}><Plus size={16} /> Log</button>
          <button onClick={() => setShowCats((s) => !s)} style={{ ...iconBtn, marginLeft: "auto", fontSize: 13 }}>
            {showCats ? "Done" : "Edit categories"}
          </button>
        </div>

        {showCats && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              {cats.map((c) => (
                <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 6px 5px 12px",
                  borderRadius: 99, background: C.bg, border: `1px solid ${C.line}`, fontSize: 13 }}>
                  {c}
                  <button onClick={() => store.deleteExpenseCat(c)} title="Remove" style={{ ...iconBtn, color: "#B4504A", padding: 2 }}><X size={13} /></button>
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="New category, e.g. Subscriptions"
                style={{ ...inputStyle, maxWidth: 260 }} onKeyDown={(e) => e.key === "Enter" && addCat()} />
              <button onClick={addCat} style={{ ...primaryBtn, background: C.greenSoft }}><Plus size={16} /> Add</button>
            </div>
          </div>
        )}

        {todaysExpenses.length > 0 && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: C.muted }}>Logged today</span>
              <strong>€{todaysSpend.toFixed(2)}</strong>
            </div>
            {todaysExpenses.slice().reverse().map((e) => (
              <div key={e.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 14, padding: "4px 0" }}>
                <span>{e.category}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  €{e.amount.toFixed(2)}
                  <button onClick={() => store.deleteExpense(e.id)} style={{ ...iconBtn, color: "#B4504A", padding: 2 }}><X size={14} /></button>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------- GOALS (tree: add branches, add goals, delete) ---------------------

function Goals({ store }) {
  const [newCat, setNewCat] = useState("");
  const addCat = () => { if (newCat.trim()) { store.addCategory(newCat); setNewCat(""); } };
  return (
    <div>
      <PageTitle kicker="Your tree" title="Goals" />
      <Card style={{ marginBottom: 16 }}>
        <Eyebrow>Categories</Eyebrow>
        <p style={{ color: C.muted, fontSize: 13, margin: "0 0 12px" }}>
          These are yours to shape — add what matters to you (say, Fun), remove what doesn't, and order them by priority.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="New category, e.g. Fun"
            style={inputStyle} onKeyDown={(e) => e.key === "Enter" && addCat()} />
          <button onClick={addCat} style={primaryBtn}><Plus size={16} /> Add category</button>
        </div>
      </Card>
      <div style={{ display: "grid", gap: 16 }}>
        {store.categories.map((cat, i) => (
          <CategoryBlock key={cat} cat={cat} store={store} index={i} count={store.categories.length} />
        ))}
        {store.categories.length === 0 && (
          <Card><p style={{ color: C.muted, margin: 0 }}>No categories. Add one above to start building your tree.</p></Card>
        )}
      </div>
    </div>
  );
}

function CategoryBlock({ cat, store, index, count }) {
  const roots = store.goals.filter((g) => g.category === cat && g.parentId === null);
  const goalCount = store.goals.filter((g) => g.category === cat).length;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cat);
  const saveRename = () => { store.renameCategory(cat, draft); setEditing(false); };
  return (
    <Card style={{ borderTop: `4px solid ${catColor(cat)}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        {editing ? (
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") { setDraft(cat); setEditing(false); } }}
            onBlur={saveRename}
            style={{ ...inputStyle, flex: "none", width: 220, fontWeight: 600 }} />
        ) : (
          <Eyebrow color={catColor(cat)}>{cat}</Eyebrow>
        )}
        <div style={{ display: "flex", gap: 2 }}>
          <button onClick={() => { setDraft(cat); setEditing(true); }} title="Rename category" style={iconBtn}><Pencil size={14} /></button>
          <button onClick={() => store.moveCategory(cat, -1)} disabled={index === 0} title="Move up"
            style={{ ...iconBtn, opacity: index === 0 ? 0.3 : 1 }}>↑</button>
          <button onClick={() => store.moveCategory(cat, 1)} disabled={index === count - 1} title="Move down"
            style={{ ...iconBtn, opacity: index === count - 1 ? 0.3 : 1 }}>↓</button>
          <button onClick={() => {
            if (goalCount === 0 || window.confirm(`Delete "${cat}" and its ${goalCount} goal(s)?`)) store.deleteCategory(cat);
          }} title="Delete category" style={{ ...iconBtn, color: "#B4504A" }}><Trash2 size={15} /></button>
        </div>
      </div>
      <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
        {roots.map((g) => <GoalNode key={g.id} goal={g} store={store} depth={0} />)}
        {roots.length === 0 && <p style={{ color: C.muted, fontSize: 14, margin: "2px 0 10px" }}>No goals here yet.</p>}
      </div>
      <AddGoalForm store={store} category={cat} parentId={null} label="Add goal" />
    </Card>
  );
}

function GoalNode({ goal, store, depth }) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const children = store.goals.filter((g) => g.parentId === goal.id);
  const hasChildren = children.length > 0;
  const pct = goalConsistency(goal, store.goals, store.completions);

  return (
    <div style={{ marginLeft: depth ? 20 : 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0" }}>
        {hasChildren ? (
          <button onClick={() => setOpen((o) => !o)} style={iconBtn}>
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        ) : <span style={{ width: 24, display: "inline-flex", justifyContent: "center", color: C.line }}><CornerDownRight size={14} /></span>}
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 600 }}>{goal.title}</span>
          <span style={{ color: C.muted, fontSize: 12, marginLeft: 8 }}>
            {hasChildren ? "branch" : cadenceLabel(goal)} · {pct}%
          </span>
        </div>
        <button onClick={() => setAdding((a) => !a)} title="Add sub-goal" style={iconBtn}><Plus size={16} /></button>
        <button onClick={() => store.deleteGoal(goal.id)} title="Delete" style={{ ...iconBtn, color: "#B4504A" }}><Trash2 size={15} /></button>
      </div>
      {adding && (
        <div style={{ marginLeft: 24, marginBottom: 6 }}>
          <AddGoalForm store={store} category={goal.category} parentId={goal.id} label="Add sub-goal" onDone={() => setAdding(false)} compact />
        </div>
      )}
      {open && children.map((c) => <GoalNode key={c.id} goal={c} store={store} depth={depth + 1} />)}
    </div>
  );
}

function AddGoalForm({ store, category, parentId, label, onDone, compact }) {
  const [title, setTitle] = useState("");
  const [freq, setFreq] = useState("daily"); // "daily" | "1".."6"
  const [period, setPeriod] = useState("ongoing"); // ongoing | 3m | 6m | 12m | custom
  const [customDate, setCustomDate] = useState("");
  const submit = () => {
    if (!title.trim()) return;
    if (period === "custom" && !customDate) return; // custom needs a date
    const cadence = freq === "daily" ? "daily" : "week";
    const perWeek = freq === "daily" ? 7 : Number(freq);
    // resolve the chosen period into a concrete end date (or null for ongoing)
    let duration = "ongoing", endDate = null;
    if (period === "3m") { duration = "until"; endDate = addMonthsISO(3); }
    else if (period === "6m") { duration = "until"; endDate = addMonthsISO(6); }
    else if (period === "12m") { duration = "until"; endDate = addMonthsISO(12); }
    else if (period === "custom") { duration = "until"; endDate = customDate; }
    store.addGoal({ category, parentId, title: title.trim(), cadence, perWeek, duration, endDate });
    setTitle(""); setPeriod("ongoing"); setCustomDate(""); onDone?.();
  };
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: compact ? 0 : 12, alignItems: "center" }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={label} style={{ ...inputStyle, minWidth: 160 }}
        onKeyDown={(e) => e.key === "Enter" && submit()} />
      <select value={freq} onChange={(e) => setFreq(e.target.value)} style={{ ...inputStyle, flex: "none", width: 170 }}>
        <option value="daily">Daily</option>
        <option value="1">Once a week</option>
        <option value="2">Twice a week</option>
        <option value="3">Three times a week</option>
        <option value="4">Four times a week</option>
        <option value="5">Five times a week</option>
        <option value="6">Six times a week</option>
      </select>
      <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ ...inputStyle, flex: "none", width: 150 }}>
        <option value="ongoing">Ongoing</option>
        <option value="3m">For 3 months</option>
        <option value="6m">For 6 months</option>
        <option value="12m">For 1 year</option>
        <option value="custom">Until a date…</option>
      </select>
      {period === "custom" && (
        <input type="date" value={customDate} min={today()} onChange={(e) => setCustomDate(e.target.value)}
          style={{ ...inputStyle, flex: "none", width: 150 }} />
      )}
      <button onClick={submit} style={primaryBtn}><Plus size={16} /> Add</button>
    </div>
  );
}
const iconBtn = { background: "transparent", border: "none", cursor: "pointer", color: C.muted, display: "inline-flex", alignItems: "center", padding: 4, borderRadius: 6 };

// ---------- PROGRESS ----------------------------------------------------------

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function GoalProgressRow({ goal, store }) {
  const comps = store.completions;
  const start = firstTick(goal, comps);
  const pct = leafConsistency(goal, comps);
  const color = catColor(goal.category);

  if (!start) {
    return (
      <div style={{ marginBottom: 16, opacity: 0.7 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
          <span style={{ fontWeight: 600 }}>{goal.title}</span>
          <span style={{ color: C.muted, fontSize: 13 }}>not started</span>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
          {cadenceLabel(goal)} · tick it on Today to begin tracking
        </div>
        <Bar value={0} color={color} />
      </div>
    );
  }

  const w = goalWindow(goal, comps);
  const done = comps.filter((c) => c.goalId === goal.id && c.date >= w.start && c.date <= w.end).length;
  const expected = expectedDays(goal, comps);
  const finished = isFinished(goal);

  // finite-plan progress (how far through the planned window we are)
  let planPct = null;
  if (goal.duration === "until" && goal.endDate) {
    const total = daysBetween(start, goal.endDate) + 1;
    const elapsed = daysBetween(start, finished ? goal.endDate : today()) + 1;
    planPct = Math.min(100, Math.round((elapsed / total) * 100));
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, alignItems: "baseline" }}>
        <span style={{ fontWeight: 600 }}>
          {goal.title}
          {finished && <span style={{ color: C.gold, fontSize: 11, fontWeight: 700, marginLeft: 8 }}>✓ completed</span>}
        </span>
        <strong>{pct}%</strong>
      </div>
      <div style={{ fontSize: 12, color: C.muted, margin: "2px 0 6px" }}>
        {cadenceLabel(goal)} · since {fmtDate(start)} · {done}/{expected} days
      </div>
      <Bar value={pct} color={color} />
      {planPct !== null && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, color: C.muted }}>
            Plan {planPct}% {finished ? "complete" : `through (ends ${fmtDate(goal.endDate)})`}
          </div>
          <Bar value={planPct} color={C.muted} />
        </div>
      )}
    </div>
  );
}


// ---------- INSIGHTS (unified weekly / monthly / yearly) ----------------------

// Consistency of a top-level ("major") goal over a date range: rolls up its leaf
// descendants (or itself if it's a leaf). Used for the major-goal progress bars.
function majorGoalRangeConsistency(goal, goals, comps, fromISO, toISO) {
  const leaves = [];
  const collect = (id) => {
    const kids = goals.filter((g) => g.parentId === id);
    if (!kids.length) return;
    for (const k of kids) { if (!goals.some((g) => g.parentId === k.id)) leaves.push(k); else collect(k.id); }
  };
  if (!goals.some((g) => g.parentId === goal.id)) leaves.push(goal); else collect(goal.id);
  const active = leaves.filter((g) => { const s = firstTick(g, comps); return s && s <= toISO; });
  if (!active.length) return null; // not started in/by this range
  const vals = active.map((g) => {
    const s = firstTick(g, comps);
    const lo = s > fromISO ? s : fromISO;
    if (lo > toISO) return 0;
    const span = daysBetween(lo, toISO) + 1;
    const expected = g.cadence === "daily" ? span : Math.max(1, Math.round((span / 7) * g.perWeek));
    const done = comps.filter((c) => c.goalId === g.id && c.date >= lo && c.date <= toISO).length;
    return Math.min(100, Math.round((done / expected) * 100));
  });
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function Insights({ store }) {
  const [view, setView] = useState("weekly"); // weekly | monthly | yearly
  const [detail, setDetail] = useState(false);
  const now = new Date();
  const year = now.getFullYear();
  const comps = store.completions;
  const isoOf = (d) => d.toISOString().slice(0, 10);

  const majors = store.goals.filter((g) => g.parentId === null);
  const allLeaves = store.goals.filter((g) => isLeaf(g, store.goals));
  const started = allLeaves.some((g) => firstTick(g, comps));

  // the active range for the current view
  let fromISO, rangeLabel;
  if (view === "weekly") {
    const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    fromISO = isoOf(monday); rangeLabel = "this week";
  } else if (view === "monthly") {
    fromISO = isoOf(new Date(year, now.getMonth(), 1)); rangeLabel = "this month";
  } else {
    fromISO = isoOf(new Date(year, 0, 1)); rangeLabel = "this year";
  }
  const toISO = today();

  const rangeComps = comps.filter((c) => c.date >= fromISO && c.date <= toISO);
  const rangeSpend = store.expenses.filter((e) => e.date >= fromISO && e.date <= toISO)
    .reduce((s, e) => s + e.amount, 0);

  // honest counts: total check-ins, and distinct days you ticked anything
  const checkIns = rangeComps.length;
  const distinctDays = new Set(rangeComps.map((c) => c.date)).size;

  // completions vs planned for the range: how many goal-days you hit vs how many
  // were expected across all active goals (the concrete, day-one-useful number).
  const planned = (() => {
    let done = 0, expected = 0;
    for (const g of allLeaves) {
      const s = firstTick(g, comps);
      if (!s || s > toISO) continue;          // not started in this range
      const lo = s > fromISO ? s : fromISO;
      const span = daysBetween(lo, toISO) + 1;
      expected += g.cadence === "daily" ? span : Math.max(1, Math.round((span / 7) * g.perWeek));
      done += comps.filter((c) => c.goalId === g.id && c.date >= lo && c.date <= toISO).length;
    }
    return { done, expected };
  })();

  // overall ring value for the active range
  const overallRange = (() => {
    const vals = majors.map((g) => majorGoalRangeConsistency(g, store.goals, comps, fromISO, toISO)).filter((v) => v !== null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  })();

  // "Best goal" only means something once there's enough history to separate goals.
  // Require the range to span at least ~2 weeks AND the goals to not be all-tied.
  const rangeSpanDays = daysBetween(fromISO, toISO) + 1;
  const bestMajor = (() => {
    if (rangeSpanDays < 14) return null; // too early to be meaningful
    const scored = majors
      .map((g) => ({ goal: g, pct: majorGoalRangeConsistency(g, store.goals, comps, fromISO, toISO) }))
      .filter((x) => x.pct !== null);
    if (scored.length < 2) return null;
    const top = scored.reduce((a, b) => (b.pct > a.pct ? b : a));
    const allSame = scored.every((x) => x.pct === scored[0].pct);
    return allSame ? null : top; // a tie isn't a "best"
  })();

  // spend-by-category for the active range
  const byCat = store.expenseCats
    .map((c) => ({ c, total: store.expenses.filter((e) => e.category === c && e.date >= fromISO && e.date <= toISO).reduce((s, e) => s + e.amount, 0) }))
    .filter((x) => x.total > 0).sort((a, b) => b.total - a.total);

  const VIEWS = [
    { id: "weekly", label: "Weekly" },
    { id: "monthly", label: "Monthly" },
    { id: "yearly", label: "Yearly" },
  ];
  const blurb = view === "weekly" ? "How this week is going"
    : view === "monthly" ? "This month — what to build on"
    : `${year} — your recap`;

  return (
    <div>
      <PageTitle kicker="Insights" title={blurb} />

      {/* view switch */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
        {VIEWS.map((v) => (
          <button key={v.id} onClick={() => setView(v.id)}
            style={{ padding: "11px", borderRadius: 12, cursor: "pointer", fontWeight: 600,
              border: `1px solid ${view === v.id ? C.green : C.line}`,
              background: view === v.id ? C.green : C.panel, color: view === v.id ? "#fff" : C.ink }}>
            {v.label}
          </button>
        ))}
      </div>

      {!started && (
        <Card><p style={{ color: C.muted, margin: 0 }}>
          Add goals on the Goals page, then tick them on Today. Your {rangeLabel} progress shows up here.
        </p></Card>
      )}

      {started && (
        <>
          {/* headline numbers — completions first (concrete), then check-ins, then spend */}
          <Card style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-around", flexWrap: "wrap", gap: 16 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "Georgia, serif", fontSize: 30, fontWeight: 700 }}>
                  {planned.done}<span style={{ color: C.muted, fontSize: 20 }}> / {planned.expected}</span>
                </div>
                <div style={{ fontSize: 12, color: C.muted }}>goal-days hit · {rangeLabel}</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontWeight: 700 }}>{checkIns}</div>
                <div style={{ fontSize: 12, color: C.muted }}>check-ins ({distinctDays} {distinctDays === 1 ? "day" : "days"})</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontWeight: 700 }}>€{rangeSpend.toFixed(2)}</div>
                <div style={{ fontSize: 12, color: C.muted }}>spent</div>
              </div>
            </div>
            {/* consistency % is a long-run measure — show it as a secondary note,
                and only headline-worthy on the yearly view where history exists */}
            {view === "yearly" && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
                <Ring value={overallRange} label="Consistency · this year" color={C.green} />
              </div>
            )}
            {bestMajor ? (
              <p style={{ color: C.greenSoft, margin: "14px 0 0", fontSize: 14, textAlign: "center" }}>
                ★ Best goal {rangeLabel}: <strong>{bestMajor.goal.title}</strong> at {bestMajor.pct}%
              </p>
            ) : (
              <p style={{ color: C.muted, margin: "14px 0 0", fontSize: 12, textAlign: "center" }}>
                Keep ticking — a standout goal appears here once there's a couple of weeks to compare.
              </p>
            )}
          </Card>

          {/* major-goal progress bars (the default view) */}
          <Card style={{ marginBottom: 16 }}>
            <Eyebrow>Your goals · {rangeLabel}</Eyebrow>
            {majors.length === 0 && <p style={{ color: C.muted, margin: "4px 0 0" }}>No goals yet.</p>}
            {majors.map((g) => {
              const pct = majorGoalRangeConsistency(g, store.goals, comps, fromISO, toISO);
              const hasSubs = store.goals.some((x) => x.parentId === g.id);
              // concrete done/expected for this major goal (sum across its leaves)
              const leaves = hasSubs ? store.goals.filter((x) => x.parentId === g.id && isLeaf(x, store.goals)) : [g];
              let gd = 0, ge = 0;
              for (const lf of leaves) {
                const s = firstTick(lf, comps);
                if (!s || s > toISO) continue;
                const lo = s > fromISO ? s : fromISO;
                const span = daysBetween(lo, toISO) + 1;
                ge += lf.cadence === "daily" ? span : Math.max(1, Math.round((span / 7) * lf.perWeek));
                gd += comps.filter((c) => c.goalId === lf.id && c.date >= lo && c.date <= toISO).length;
              }
              return (
                <div key={g.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                    <span style={{ fontWeight: 600 }}>
                      {g.title}
                      <span style={{ color: C.muted, fontSize: 12, fontWeight: 400 }}> · {g.category}{hasSubs ? " · group" : ""}</span>
                    </span>
                    <span>
                      {pct === null ? <span style={{ color: C.muted }}>not started</span>
                        : <><strong>{gd}/{ge}</strong> <span style={{ color: C.muted, fontSize: 12 }}>· {pct}%</span></>}
                    </span>
                  </div>
                  <Bar value={pct ?? 0} color={catColor(g.category)} />
                </div>
              );
            })}
          </Card>

          {/* detail toggle */}
          <button onClick={() => setDetail((d) => !d)}
            style={{ ...primaryBtn, background: C.panel, color: C.green, border: `1px solid ${C.line}`, marginBottom: 16 }}>
            {detail ? "Hide detail" : "Show all goals & spending detail"}
          </button>

          {detail && (
            <>
              {/* every goal, since its first tick, grouped by category */}
              <div style={{ display: "grid", gap: 16, marginBottom: 16 }}>
                {store.categories.map((cat) => {
                  const leaves = store.goals.filter((g) => g.category === cat && isLeaf(g, store.goals));
                  if (!leaves.length) return null;
                  return (
                    <Card key={cat} style={{ borderTop: `4px solid ${catColor(cat)}` }}>
                      <Eyebrow color={catColor(cat)}>{cat}</Eyebrow>
                      {leaves.map((g) => <GoalProgressRow key={g.id} goal={g} store={store} />)}
                    </Card>
                  );
                })}
              </div>

              {/* spending breakdown for the range */}
              {byCat.length > 0 && (
                <Card>
                  <Eyebrow>Where the money went · {rangeLabel}</Eyebrow>
                  {byCat.map(({ c, total }) => (
                    <div key={c} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                        <span>{c}</span><strong>€{total.toFixed(2)}</strong>
                      </div>
                      <Bar value={rangeSpend ? (total / rangeSpend) * 100 : 0} color={C.gold} />
                    </div>
                  ))}
                </Card>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}