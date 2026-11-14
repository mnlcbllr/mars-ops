import { useEffect, useRef, useState } from "react";
import { MissionWorkspace } from "@/components/MissionWorkspace";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/api";
import { loadWorkspace, type Workspace } from "@/lib/workspace";

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // StrictMode replays effects; opening twice would race the shared backend session.
  const loading = useRef<Promise<Workspace> | null>(null);

  useEffect(() => {
    let active = true;
    loading.current ??= loadWorkspace();
    loading.current.then(
      (loaded) => { if (active) setWorkspace(loaded); },
      (failure) => { if (active) setError(errorText(failure)); },
    );
    return () => { active = false; };
  }, [attempt]);

  if (workspace) return <MissionWorkspace workspace={workspace} />;

  return (
    <main className="flex h-full flex-col bg-background text-foreground">
      <header className="flex min-h-14 items-center gap-4 border-b px-5">
        <h1 className="text-lg font-semibold tracking-widest">ARES</h1>
        <span className="text-sm text-muted-foreground">Mars excursion planner</span>
        <span className="ml-auto text-xs text-muted-foreground">Research prototype · not flight software</span>
      </header>
      <section className="grid flex-1 place-content-center gap-4 p-8 text-center">
        {error ? <>
          <h2 className="font-medium">Could not open the map</h2>
          <p role="alert" className="max-w-lg text-sm text-muted-foreground">{error}</p>
          <Button onClick={() => { loading.current = null; setError(null); setAttempt((n) => n + 1); }}>Retry</Button>
        </> : <p role="status">Loading bundled Mars dataset…</p>}
      </section>
    </main>
  );
}
