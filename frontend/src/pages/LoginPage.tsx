import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { API, login } from "../api";

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
      const r = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(body?.error?.message || body?.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      login(data.access_token, { username: data.username, role: data.role });
      navigate("/", { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#020817",
    }}>
      <form onSubmit={handleSubmit} style={{
        width: 340,
        padding: 32,
        borderRadius: 12,
        border: "1px solid #1e293b",
        backgroundColor: "#0f172a",
      }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="2" width="22" height="6" rx="1.5" />
            <rect x="1" y="16" width="22" height="6" rx="1.5" />
            <line x1="6" y1="8" x2="6" y2="16" />
            <line x1="18" y1="8" x2="18" y2="16" />
          </svg>
          <h2 style={{ color: "#e2e8f0", fontSize: 18, fontWeight: 700, marginTop: 8, fontFamily: "'Inter', system-ui, sans-serif" }}>
            NetMap Login
          </h2>
        </div>

        {error && (
          <div style={{
            padding: "8px 12px",
            marginBottom: 16,
            borderRadius: 6,
            backgroundColor: "#450a0a",
            border: "1px solid #7f1d1d",
            color: "#fca5a5",
            fontSize: 12,
          }}>
            {error}
          </div>
        )}

        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ color: "#94a3b8", fontSize: 12, display: "block", marginBottom: 4 }}>Username</span>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            required
            autoFocus
            autoComplete="username"
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid #334155",
              backgroundColor: "#1e293b",
              color: "#e2e8f0",
              fontSize: 13,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </label>

        <label style={{ display: "block", marginBottom: 20 }}>
          <span style={{ color: "#94a3b8", fontSize: 12, display: "block", marginBottom: 4 }}>Password</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid #334155",
              backgroundColor: "#1e293b",
              color: "#e2e8f0",
              fontSize: 13,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </label>

        <button
          type="submit"
          disabled={loading}
          style={{
            width: "100%",
            padding: "9px 0",
            borderRadius: 6,
            border: "none",
            backgroundColor: "#0891b2",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </div>
  );
}
