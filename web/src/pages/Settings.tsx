import { useState } from "react";
import { save, settings, sm } from "../api";
import { Button } from "@/components/ui/button";
import { useApp } from "../shared";

export function Settings() {
  const { toast, bump } = useApp();
  const [key, setKey] = useState(settings.key);
  const [base, setBase] = useState(settings.base);
  const [testing, setTesting] = useState(false);

  const apply = async () => {
    save("sm.apiKey", key.trim());
    save("sm.baseUrl", base.trim() || "/api");
    setTesting(true);
    try {
      const spaces = await sm.spaces();
      toast({ text: `Connected · ${spaces.length} space${spaces.length === 1 ? "" : "s"}` });
      bump();
    } catch (e) {
      toast({ text: `Saved, but the server said: ${(e as Error).message}`, tone: "danger" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Where this UI finds your memory server. Stored in this browser only.</p>
        </div>
      </header>
      <form
        className="tray"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="tray-head">Connection</div>
        <div className="card settings-card">
          <div className="field">
            <label htmlFor="key">API key</label>
            <input id="key" className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
            <span className="hint">Sent as Authorization: Bearer on every request. Matches SUPERMEM_API_KEY on the server.</span>
          </div>
          <div className="field">
            <label htmlFor="base">Base URL</label>
            <input id="base" className="input" value={base} onChange={(e) => setBase(e.target.value)} placeholder="/api" />
            <span className="hint">/api goes through the Vite dev proxy to 127.0.0.1:6767. Use a full URL for a remote server (it must allow CORS).</span>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="submit" loading={testing}>Save and test</Button>
          </div>
        </div>
      </form>
    </div>
  );
}
