import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { inputCls } from "./ui";

/** Password input with a show/hide eye button. */
export function PasswordField({ value, onChange, autoComplete, placeholder }: { value: string; onChange: (v: string) => void; autoComplete: string; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input required minLength={8} type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} w-full pr-11`} autoComplete={autoComplete} placeholder={placeholder} />
      <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}
        className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-ink-400 hover:bg-ink-800 hover:text-ink-100">
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
