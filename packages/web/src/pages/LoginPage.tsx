import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiClient } from "../lib/api.js";
import { useAuthStore } from "../stores/auth.js";

export function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("demo@example.com");
  const [password, setPassword] = useState("demo1234");
  const [name, setName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const setAuth = useAuthStore((s) => s.setAuth);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const endpoint = mode === "login" ? "/v1/auth/login" : "/v1/auth/register";
      const payload = mode === "login"
        ? { email, password }
        : { email, password, name, workspaceName };

      const res = await apiClient.post<{
        token: string;
        user: { id: string; email: string; name?: string };
        workspaceId?: string;
      }>(endpoint, payload);

      setAuth(
        res.data.token,
        res.data.user,
        res.data.workspaceId ?? ""
      );
      navigate("/copilot");
    } catch {
      setError("Invalid email or password. Try demo@example.com / demo1234");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-sm font-bold mx-auto mb-3">
            AC
          </div>
          <h1 className="text-xl font-semibold text-gray-100">Analytics Copilot</h1>
          <p className="text-sm text-gray-500 mt-1">Self-hosted product analytics with AI</p>
        </div>

        <div className="glass-panel p-6">
          {/* Mode toggle */}
          <div className="flex rounded-lg bg-gray-900 p-0.5 mb-6">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 py-1.5 text-sm rounded-md capitalize transition-colors ${
                  mode === m ? "bg-gray-700 text-gray-100" : "text-gray-400 hover:text-gray-200"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            {mode === "register" && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">Name</label>
                  <input className="input" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">Workspace name</label>
                  <input className="input" type="text" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="Acme Inc." required />
                </div>
              </>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Email</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Password</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>

            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full justify-center disabled:opacity-50">
              {loading ? "Signing in…" : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-600 mt-4">
          Demo: demo@example.com / demo1234
        </p>
      </div>
    </div>
  );
}
