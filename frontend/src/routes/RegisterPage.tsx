import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

export function RegisterPage() {
  const register = useAuthStore((s) => s.register);
  const navigate = useNavigate();
  // Picked on the landing page palette: open the create dialog with it once signed up.
  const template = (useLocation().state as { template?: string } | null)?.template;
  const [form, setForm] = useState({ email: "", username: "", display_name: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({
        email: form.email.trim(),
        username: form.username.trim(),
        password: form.password,
        display_name: form.display_name.trim() || undefined,
      });
      navigate(template ? `/dashboard?template=${encodeURIComponent(template)}` : "/dashboard", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    key: keyof typeof form,
    label: string,
    props: React.ComponentProps<"input"> = {},
    help?: string,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={key}>{label}</Label>
      <Input
        id={key}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        aria-describedby={help ? `${key}-help` : undefined}
        {...props}
      />
      {help && (
        <p id={`${key}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );

  return (
    <div>
      <h1 className="font-display text-xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-muted-foreground">Then pick a language and you're running code.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        {field("email", "Email", { type: "email", required: true, autoComplete: "email", autoFocus: true })}
        {field(
          "username",
          "Username",
          {
            required: true,
            autoComplete: "username",
            pattern: "[A-Za-z0-9_\\-]{3,32}",
            title: "3-32 letters, digits, _ or -",
          },
          "3 to 32 letters, digits, _ or -. Shown on your public repls.",
        )}
        {field("display_name", "Display name (optional)")}
        {field(
          "password",
          "Password",
          { type: "password", required: true, minLength: 8, autoComplete: "new-password" },
          "At least 8 characters.",
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />} Create account
        </Button>
      </form>
      <p className="mt-6 border-t pt-4 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/login" className="text-primary hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
