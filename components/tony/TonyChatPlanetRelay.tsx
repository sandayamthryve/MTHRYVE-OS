"use client";

import { useEffect, useState } from "react";

type RelayRect = { left: number; top: number; width: number; height: number };

const TONY_SIGNAL_DOCUMENT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Tony signal planet</title>
  <link rel="stylesheet" href="/tony/orbit.css" />
  <link rel="stylesheet" href="/tony/planet-preview.css" />
</head>
<body>
  <canvas id="preview" aria-label="Tony signal planet"></canvas>
  <div class="tstage" id="tstage"><div id="tmeta"></div><div id="orbcap"></div></div>
  <script src="/tony/three-r128.min.js"></script>
  <script src="/tony/orbit.js"></script>
  <script src="/tony/tony-signal-preview.js"></script>
</body>
</html>`;

function sameRect(a: RelayRect | null, b: RelayRect | null) {
  if (!a || !b) return a === b;
  return Math.abs(a.left - b.left) < .5 && Math.abs(a.top - b.top) < .5 && Math.abs(a.width - b.width) < .5 && Math.abs(a.height - b.height) < .5;
}

export function TonyChatPlanetRelay() {
  const [rect, setRect] = useState<RelayRect | null>(null);

  useEffect(() => {
    let raf = 0;
    let settleUntil = 0;

    const sync = () => {
      const pod = document.querySelector<HTMLElement>(".tonyHoloPod");
      if (!pod) {
        setRect((current) => current ? null : current);
        return;
      }
      const box = pod.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) {
        setRect((current) => current ? null : current);
        return;
      }
      const next = { left: box.left, top: box.top, width: box.width, height: box.height };
      setRect((current) => sameRect(current, next) ? current : next);
    };

    const followOpeningAnimation = () => {
      sync();
      if (performance.now() < settleUntil) raf = requestAnimationFrame(followOpeningAnimation);
    };

    const kick = () => {
      cancelAnimationFrame(raf);
      settleUntil = performance.now() + 850;
      raf = requestAnimationFrame(followOpeningAnimation);
    };

    const observer = new MutationObserver(kick);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", kick);
    kick();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", kick);
      cancelAnimationFrame(raf);
    };
  }, []);

  if (!rect) return null;

  return (
    <div
      className="tonyPlanetSignalRelay"
      aria-hidden="true"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      <div className="relayCircle">
        <iframe
          className="tonyPlanetSignalFrame"
          srcDoc={TONY_SIGNAL_DOCUMENT}
          title="Tony hologram planet"
          tabIndex={-1}
        />
        <div className="relayVignette" />
        <div className="relayScan" />
        <div className="relayRing relayRingA" />
        <div className="relayRing relayRingB" />
        <div className="relaySignal relaySignalOne" />
        <div className="relaySignal relaySignalTwo" />
        <div className="relaySignal relaySignalThree" />
      </div>
      <div className="relayCaption">TONY // SIGNAL LINK</div>

      <style jsx global>{`
        /* Render the exact Tony sun shader in a srcDoc frame. srcDoc avoids the
           app's frame-denial response headers while the external self-hosted
           scripts still obey CSP. */
        body:has(.tonyPlanetSignalRelay) .tonyHoloPod .holoBlock{display:none!important}

        .tonyPlanetSignalRelay{
          position:fixed;
          z-index:74;
          overflow:visible;
          pointer-events:none;
          animation:relayMaterialize .34s ease-out both;
        }
        .relayCircle{
          position:absolute;
          inset:0;
          overflow:hidden;
          border-radius:50%;
          clip-path:circle(50% at 50% 50%);
          box-shadow:inset 0 0 36px rgba(91,218,255,.16),0 0 28px rgba(61,184,229,.12);
        }
        .tonyPlanetSignalFrame{
          position:absolute;
          inset:4%;
          width:92%;
          height:92%;
          border:0;
          background:transparent;
          border-radius:50%;
          transform:scale(.9);
          filter:saturate(.96) contrast(1.06) brightness(1.08);
          opacity:.97;
          animation:relayPlanetFloat 3.1s ease-in-out infinite;
        }
        .relayVignette{
          position:absolute;inset:0;border-radius:50%;
          background:radial-gradient(circle at 50% 48%,transparent 38%,rgba(40,176,220,.06) 57%,rgba(2,13,22,.52) 84%,rgba(2,9,16,.8) 100%);
          box-shadow:inset 0 0 22px rgba(104,224,255,.12);
        }
        .relayScan{
          position:absolute;left:10%;right:10%;height:2px;top:14%;
          background:linear-gradient(90deg,transparent,rgba(151,238,255,.92),transparent);
          box-shadow:0 0 15px rgba(85,217,255,.9);
          animation:relayScan 2.1s ease-in-out infinite;
        }
        .relayRing{position:absolute;border-radius:50%;border:1px solid rgba(96,221,255,.26);box-shadow:0 0 12px rgba(84,205,245,.12)}
        .relayRingA{inset:13%;animation:relayPulseRing 2.4s ease-out infinite}
        .relayRingB{inset:23%;border-style:dashed;border-color:rgba(167,139,250,.3);animation:relaySpin 8s linear infinite}
        .relaySignal{position:absolute;left:50%;top:50%;border:1px solid rgba(112,228,255,.35);border-radius:50%;transform:translate(-50%,-50%);opacity:0}
        .relaySignalOne{width:42%;height:42%;animation:relayBroadcast 2.25s ease-out infinite}
        .relaySignalTwo{width:42%;height:42%;animation:relayBroadcast 2.25s ease-out .72s infinite}
        .relaySignalThree{width:42%;height:42%;animation:relayBroadcast 2.25s ease-out 1.44s infinite}
        .relayCaption{
          position:absolute;
          left:50%;
          top:calc(100% + 10px);
          transform:translateX(-50%);
          width:max-content;
          max-width:calc(100% + 40px);
          padding:5px 10px 4px;
          border:1px solid rgba(96,221,255,.2);
          border-radius:999px;
          background:rgba(3,13,22,.82);
          box-shadow:0 0 16px rgba(80,215,249,.12),inset 0 0 12px rgba(80,215,249,.04);
          text-align:center;
          color:#82dff5;
          font:800 9px/1 ui-monospace,monospace;
          letter-spacing:.17em;
          text-shadow:0 0 12px rgba(80,215,249,.72);
          white-space:nowrap;
        }

        @keyframes relayMaterialize{from{opacity:0;filter:blur(7px) brightness(2)}to{opacity:1;filter:none}}
        @keyframes relayPlanetFloat{0%,100%{transform:scale(.9) translateY(1px)}50%{transform:scale(.93) translateY(-3px)}}
        @keyframes relayScan{0%,100%{top:14%;opacity:.2}50%{top:80%;opacity:.92}}
        @keyframes relayPulseRing{0%,100%{transform:scale(.96);opacity:.3}50%{transform:scale(1.04);opacity:.76}}
        @keyframes relaySpin{to{transform:rotate(360deg)}}
        @keyframes relayBroadcast{0%{transform:translate(-50%,-50%) scale(.7);opacity:.55}75%,100%{transform:translate(-50%,-50%) scale(2.05);opacity:0}}

        @media(max-width:640px){.tonyPlanetSignalRelay{display:none}}
        @media(prefers-reduced-motion:reduce){.tonyPlanetSignalRelay,.tonyPlanetSignalFrame,.relayScan,.relayRing,.relaySignal{animation:none!important}}
      `}</style>
    </div>
  );
}
