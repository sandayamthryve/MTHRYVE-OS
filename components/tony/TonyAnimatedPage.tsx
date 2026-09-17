"use client";

import { TonyNorthStarPage, type TonyInitialMessage } from "./TonyNorthStarPage";
import { type ToneSettings } from "@/lib/assistant/tone";

type Props = {
  initialConversationId?: string | null;
  initialMessages?: TonyInitialMessage[];
  orgId: string;
  userId: string;
  tone: ToneSettings;
};

/**
 * Tony is a full-bleed immersive surface. Navigation lives entirely in the
 * floating icon rail (TonySideRail) that overlays the canvas — no text sidebar
 * panel, so nothing overlaps the rail or steals width from the cognition view.
 */
export function TonyAnimatedPage(props: Props) {
  return (
    <div className="tonyAnimationShell">
      <div className="tonyCanvasArea">
        <TonyNorthStarPage {...props} />
        <div className="tonyAmbientPulse" aria-hidden="true" />
      </div>

      <style jsx global>{`
        .tonyAnimationShell {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100dvh;
          min-height: 0;
          overflow: hidden;
          background: #020409;
        }

        .tonyCanvasArea {
          position: fixed;
          inset: 0;
          overflow: hidden;
          background: #020409;
        }

        .tonyCanvasArea .tonyNS {
          position: absolute !important;
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
          animation: tonyPageReveal 820ms cubic-bezier(.2,.8,.2,1) both;
        }

        /* The floating TonySideRail is the navigation from md up, so Tony's
           own hamburger drawer only survives below that breakpoint. */
        @media (min-width: 768px) {
          .tonyAnimationShell .tfToggle,
          .tonyAnimationShell .backdrop,
          .tonyAnimationShell .drawer {
            display: none !important;
          }
        }

        .tonyAnimationShell .orbitFrame {
          transform-origin: 50% 48%;
          will-change: transform, filter, opacity;
          animation:
            tonyOrbitReveal 1200ms cubic-bezier(.16,.84,.24,1) both,
            tonyOrbitBreathe 7.5s ease-in-out 1200ms infinite;
        }

        .tonyAnimationShell .tfDock {
          animation:
            tonyDockReveal 720ms cubic-bezier(.16,.84,.24,1) 260ms both,
            tonyDockFloat 5s ease-in-out 1100ms infinite;
        }

        .tonyAnimationShell .tfIcons,
        .tonyAnimationShell .tzoom {
          animation: tonyControlsReveal 650ms ease-out 500ms both;
        }

        .tonyAnimationShell .thint {
          animation: tonyHintReveal 900ms ease-out 800ms both;
        }

        .tonyAnimationShell .orbstate.idle {
          animation: tonyIdleStatus 2.4s ease-in-out infinite;
        }

        .tonyAnimationShell .orbstate.listening {
          animation: tonyListeningStatus 950ms ease-in-out infinite;
        }

        .tonyAnimationShell .orbstate.thinking {
          animation: tonyThinkingStatus 1.25s ease-in-out infinite;
        }

        .tonyAnimationShell .orbstate.speaking {
          animation: tonySpeakingStatus 650ms ease-in-out infinite;
        }

        .tonyAmbientPulse {
          position: absolute;
          z-index: 2;
          pointer-events: none;
          left: 50%;
          top: 46%;
          width: min(32vw, 430px);
          aspect-ratio: 1;
          border-radius: 999px;
          transform: translate(-50%, -50%) scale(.72);
          background: radial-gradient(circle, rgba(255,181,71,.12) 0%, rgba(167,139,250,.055) 38%, transparent 70%);
          mix-blend-mode: screen;
          filter: blur(18px);
          opacity: .24;
          animation: tonyAmbientBreath 3.2s ease-in-out infinite;
        }

        @keyframes tonyPageReveal {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes tonyOrbitReveal {
          0% { opacity: 0; transform: scale(.88); filter: blur(12px) brightness(.65); }
          55% { opacity: 1; filter: blur(1px) brightness(1.12); }
          100% { opacity: 1; transform: scale(1); filter: blur(0) brightness(1); }
        }

        @keyframes tonyOrbitBreathe {
          0%, 100% { transform: scale(1); filter: saturate(1) brightness(1); }
          50% { transform: scale(1.008); filter: saturate(1.08) brightness(1.035); }
        }

        @keyframes tonyDockReveal {
          from { opacity: 0; transform: translateX(-50%) translateY(28px) scale(.97); }
          to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
        }

        @keyframes tonyDockFloat {
          0%, 100% { transform: translateX(-50%) translateY(0); }
          50% { transform: translateX(-50%) translateY(-3px); }
        }

        @keyframes tonyControlsReveal {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes tonyHintReveal {
          from { opacity: 0; letter-spacing: .28em; }
          to { opacity: 1; }
        }

        @keyframes tonyIdleStatus {
          0%, 100% { opacity: .72; text-shadow: 0 0 0 rgba(255,190,92,0); }
          50% { opacity: 1; text-shadow: 0 0 14px rgba(255,190,92,.38); }
        }

        @keyframes tonyListeningStatus {
          0%, 100% { opacity: .72; transform: scale(.99); }
          50% { opacity: 1; transform: scale(1.02); text-shadow: 0 0 15px rgba(94,200,255,.55); }
        }

        @keyframes tonyThinkingStatus {
          0%, 100% { opacity: .68; }
          50% { opacity: 1; text-shadow: 0 0 16px rgba(167,139,250,.6); }
        }

        @keyframes tonySpeakingStatus {
          0%, 100% { transform: scale(.985); opacity: .78; }
          50% { transform: scale(1.025); opacity: 1; text-shadow: 0 0 16px rgba(255,209,102,.62); }
        }

        @keyframes tonyAmbientBreath {
          0%, 100% { opacity: .16; transform: translate(-50%, -50%) scale(.72); }
          50% { opacity: .34; transform: translate(-50%, -50%) scale(1.08); }
        }

        @media (prefers-reduced-motion: reduce) {
          .tonyAnimationShell .tonyNS,
          .tonyAnimationShell .orbitFrame,
          .tonyAnimationShell .tfDock,
          .tonyAnimationShell .tfIcons,
          .tonyAnimationShell .tzoom,
          .tonyAnimationShell .thint,
          .tonyAnimationShell .orbstate,
          .tonyAmbientPulse {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}
