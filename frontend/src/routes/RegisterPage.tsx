import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

export function RegisterPage() {
  const register = useAuthStore((s) => s.register);
  const navigate = useNavigate();
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
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof typeof form, label: string, props: React.ComponentProps<"input"> = {}) => (
    <div className="space-y-2">
      <Label htmlFor={key}>{label}</Label>
      <Input
        id={key}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        {...props}
      />
    </div>
  );

  return (
    <Card className="gap-5 px-1 sm:px-3">
      <CardHeader>
        <CardTitle className="text-2xl font-semibold tracking-[-0.01em]">Create your account</CardTitle>
        <CardDescription>After this, pick a language and press Run.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {field("email", "Email", { type: "email", required: true, autoComplete: "email" })}
          {field("username", "Username", {
            required: true,
            autoComplete: "username",
            pattern: "[A-Za-z0-9_\\-]{3,32}",
            title: "3-32 letters, digits, _ or -",
          })}
          {field("display_name", "Display name, optional")}
          {field("password", "Password", {
            type: "password",
            required: true,
            minLength: 8,
            autoComplete: "new-password",
          })}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} Create account
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
              Log in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
