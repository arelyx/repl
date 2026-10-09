import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/stores/theme"

const Toaster = ({ ...props }: ToasterProps) => {
  const mode = useTheme((s) => s.mode)
  return (
    <Sonner
      theme={mode === "dusk" ? "dark" : "light"}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
