import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, extractErrorMessage, login } from "../api";
import { Button, Input } from "../components/ui";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await api.post("/api/auth/login", { username, password });
      login(data.access_token, { username: data.username, role: data.role });
      navigate("/", { replace: true });
    } catch (err: unknown) {
      // api.post errors carry an "HTTP <status>: " prefix - strip it for display
      setError(extractErrorMessage(err).replace(/^HTTP \d+:\s*/, "") || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <form
        onSubmit={handleSubmit}
        className="w-[340px] p-8 rounded-xl border border-line bg-panel"
      >
        <div className="text-center mb-6">
          <svg className="inline-block" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="2" width="22" height="6" rx="1.5" />
            <rect x="1" y="16" width="22" height="6" rx="1.5" />
            <line x1="6" y1="8" x2="6" y2="16" />
            <line x1="18" y1="8" x2="18" y2="16" />
          </svg>
          <h2 className="text-primary text-lg font-bold mt-2">
            NetMap Login
          </h2>
        </div>

        {error && (
          <div className="px-3 py-2 mb-4 rounded-md bg-panel-2 border border-danger text-danger text-xs">
            {error}
          </div>
        )}

        <label className="block mb-3">
          <span className="text-muted text-xs block mb-1">Username</span>
          <Input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            required
            autoFocus
            autoComplete="username"
          />
        </label>

        <label className="block mb-5">
          <span className="text-muted text-xs block mb-1">Password</span>
          <Input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>

        <Button type="submit" variant="primary" disabled={loading} className="w-full">
          {loading ? "Signing in..." : "Sign In"}
        </Button>
      </form>
    </div>
  );
}
