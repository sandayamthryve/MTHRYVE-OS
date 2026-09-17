export default function Loading() {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#080b11]"
      role="status"
      aria-live="polite"
      aria-label="Loading page"
    >
      <div className="flex flex-col items-center gap-5">
        <div className="relative h-14 w-14">
          <div className="absolute inset-0 rounded-full border-2 border-white/10" />
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-white/90 border-r-white/40" />
          <div className="absolute inset-[7px] animate-pulse rounded-full bg-white/[0.04]" />
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white/80">
            M-THRYVE OS
          </p>
          <p className="text-[11px] tracking-[0.16em] text-white/35">
            Loading workspace...
          </p>
        </div>

        <div className="h-px w-28 overflow-hidden bg-white/10">
          <div className="h-full w-1/2 animate-[loading-bar_1s_ease-in-out_infinite] bg-white/70" />
        </div>
      </div>

      <style>{`
        @keyframes loading-bar {
          0% { transform: translateX(-110%); }
          50% { transform: translateX(55%); }
          100% { transform: translateX(220%); }
        }
      `}</style>
    </div>
  );
}
