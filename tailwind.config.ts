import type { Config } from "tailwindcss";

// Mthryve OS design tokens. The Operator dashboard is the canonical palette:
// cool obsidian base, blue-charcoal surfaces, teal actions, restrained accents.
const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./features/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        obsidian: "#080D12",
        charcoal: {
          950: "#0B1117",
          900: "#111A23",
          850: "#16212B",
          800: "#1B2833",
          700: "#263744",
        },
        teal: {
          500: "#2FA8A0",
          400: "#4BC0B8",
          300: "#5FD8CF",
        },
        green: {
          500: "#4CAF6D",
          400: "#6BC98A",
        },
        gold: {
          500: "#D4A94B",
          400: "#E0BD6E",
        },
        ink: {
          DEFAULT: "#E8ECEC",
          muted: "#93A1A1",
          dim: "#63727A",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "16px",
      },
      boxShadow: {
        elevate: "0 20px 50px -12px rgba(0,0,0,.65), 0 2px 6px rgba(0,0,0,.4)",
        glow: "0 6px 18px -4px rgba(47,168,160,.5)",
        "glow-gold": "0 6px 18px -4px rgba(212,169,75,.5)",
      },
    },
  },
  plugins: [],
};

export default config;
