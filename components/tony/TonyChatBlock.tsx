"use client";

import { useEffect, useRef, useState } from "react";
import { openAssistantStream } from "@/lib/assistant/client-stream";

type ChatLine = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

type Props = {
  initialConversationId?: string | null;
  initialMessages?: Array<{ role: "user" | "assistant"; content: string }>;
};

type ComposerRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

// Total horizontal inset of the trigger against the composer, split evenly on
// each side so it stays centred. The tab should read as a cap sitting on the
// composer's top edge, which only works if it is clearly narrower -- matching
// the composer's width made the two edges line up and the tab looked like part
// of the field rather than something resting on it.
const TRIGGER_INSET = 28;

export function TonyChatBlock({ initialConversationId = null, initialMessages = [] }: Props) {
  const conversation = useRef<string | null>(initialConversationId);
  const abortRef = useRef<AbortController | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const nextId = useRef(initialMessages.length + 1);
  const [open, setOpen] = useState(false);
  const [showTony, setShowTony] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [composerRect, setComposerRect] = useState<ComposerRect | null>(null);
  const [lines, setLines] = useState<ChatLine[]>(() =>
    initialMessages.map((message, index) => ({
      id: index + 1,
      role: message.role,
      content: message.content,
    })),
  );

  useEffect(() => {
    // The trigger is a fixed-position card mirroring the composer's painted box,
    // so it has to follow every move the composer makes -- and wait for it to
    // exist at all. Two things broke that:
    //
    // 1. The composer belongs to the Tony scene, which mounts after this block.
    //    Querying once and bailing on null meant that on a slow first paint the
    //    trigger simply never appeared.
    // 2. The composer moves under CSS animation: tonyContentReveal slides the
    //    dock up 12px on arrival and the animation shell settles a scale() /
    //    translateY() on top. Those change the painted box but NOT the layout
    //    box, so ResizeObserver never fires for them and neither does
    //    window.resize. The old sync ran once at mount, mid-animation, and left
    //    the card stranded up to ~40px low -- its 13px tab landing inside the
    //    composer and printing "OPEN CHAT MODE" across the placeholder.
    //
    // Re-reading the painted rect each frame covers animation, scroll and zoom
    // alike. The element is cached until it drops out of the document, and
    // state is set only when the box actually changed, so once things settle
    // this costs one getBoundingClientRect per frame and no re-renders.
    let frame = 0;
    let previous = "";
    let composer: HTMLElement | null = null;

    const sync = () => {
      if (!composer?.isConnected) {
        composer = document.querySelector<HTMLElement>(".tonyNS .tfDock .mic");
      }

      if (composer) {
        const rect = composer.getBoundingClientRect();
        const key = `${rect.left}|${rect.top}|${rect.width}|${rect.height}`;
        if (key !== previous) {
          previous = key;
          setComposerRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
        }
      } else if (previous !== "") {
        // Scene unmounted -- drop the trigger rather than leave it floating.
        previous = "";
        setComposerRect(null);
      }

      frame = requestAnimationFrame(sync);
    };

    frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [lines, open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function sendMessage() {
    const message = input.trim();
    if (!message || busy) return;

    setInput("");
    setBusy(true);
    const userId = nextId.current++;
    const assistantId = nextId.current++;
    setLines((current) => [
      ...current,
      { id: userId, role: "user", content: message },
      { id: assistantId, role: "assistant", content: "" },
    ]);

    try {
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await openAssistantStream(
        { conversationId: conversation.current, message },
        controller.signal,
      );

      if (result.kind === "json") {
        const error = typeof result.data.error === "string" ? result.data.error : "Tony is temporarily unavailable.";
        setLines((current) => current.map((line) => line.id === assistantId ? { ...line, content: error } : line));
        return;
      }

      let answer = "";
      for await (const event of result.events) {
        if (event.type === "meta" && event.conversationId) conversation.current = event.conversationId;
        if (event.type === "delta") {
          answer += event.text;
          setLines((current) => current.map((line) => line.id === assistantId ? { ...line, content: answer } : line));
        }
        if (event.type === "error") {
          answer = event.error;
          setLines((current) => current.map((line) => line.id === assistantId ? { ...line, content: answer } : line));
        }
      }

      if (!answer) {
        setLines((current) => current.map((line) => line.id === assistantId ? { ...line, content: "I could not produce a grounded answer for that ask." } : line));
      }
    } catch {
      setLines((current) => current.map((line) => line.id === assistantId ? { ...line, content: "Tony is temporarily unavailable." } : line));
    } finally {
      setBusy(false);
    }
  }

  const triggerStyle = composerRect
    ? {
        left: `${composerRect.left + TRIGGER_INSET / 2}px`,
        top: `${composerRect.top}px`,
        width: `${composerRect.width - TRIGGER_INSET}px`,
        height: `${composerRect.height}px`,
      }
    : undefined;

  return (
    <>
      {composerRect && (
        <button
          type="button"
          className={`tonyChatTrigger${open ? " active" : ""}`}
          style={triggerStyle}
          aria-expanded={open}
          aria-controls="tony-chat-mode-panel"
          onClick={() => setOpen((value) => !value)}
        >
          <span>{open ? "CLOSE CHAT MODE" : "OPEN CHAT MODE"}</span>
        </button>
      )}

      {open && (
        <div className="tonyChatPortal" aria-live="polite">
          <div className="tonyTvFlash" aria-hidden="true" />
          <div className={`tonyChatHud${showTony ? "" : " tonyHidden"}`} id="tony-chat-mode-panel" role="dialog" aria-label="Tony chat mode">
            {showTony && (
              <div className="tonyHoloPod" aria-hidden="true">
                <div className="holoOrbit orbitA" />
                <div className="holoOrbit orbitB" />
                <div className="holoGrid" />
                <div className="holoBlock">
                  <i className="face one" />
                  <i className="face two" />
                  <i className="face three" />
                </div>
                <div className="holoScan" />
                <div className="holoCaption">TONY // HOLO LINK</div>
              </div>
            )}

            <div className="chatPanelWrap">
              <button
                type="button"
                className="tonyVisualToggle"
                aria-pressed={!showTony}
                onClick={() => setShowTony((value) => !value)}
              >
                <span className="tonyToggleDot" aria-hidden="true" />
                {showTony ? "HIDE TONY" : "SHOW TONY"}
              </button>

              <section className="tonyChatPanel">
                <div className="panelScanlines" aria-hidden="true" />
                <header className="chatHeader">
                  <div>
                    <b>TONY // CHAT MODE</b>
                    <span>{busy ? "THINKING" : "LIVE LINK"}</span>
                  </div>
                  <button type="button" className="chatClose" aria-label="Close chat mode" onClick={() => setOpen(false)}>×</button>
                </header>

                <div className="chatFeed" ref={feedRef} role="log" aria-label="Tony chat transcript">
                  {lines.length === 0 && (
                    <div className="emptyChat">
                      <span>HOLOGRAPHIC CHANNEL READY</span>
                      <p>Ask Tony anything. This chat continues on the same Tony conversation spine.</p>
                    </div>
                  )}
                  {lines.map((line) => (
                    <div key={line.id} className={`chatBubble ${line.role}`}>
                      <small>{line.role === "assistant" ? "TONY" : "YOU"}</small>
                      <div>{line.content || "Thinking…"}</div>
                    </div>
                  ))}
                </div>

                <div className="chatComposer">
                  <textarea
                    aria-label="Message Tony in chat mode"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                    placeholder="Talk to Tony..."
                    rows={1}
                    disabled={busy}
                  />
                  <button type="button" disabled={busy || !input.trim()} onClick={() => void sendMessage()} aria-label="Send chat message">↑</button>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        /* The real Chat Mode trigger replaces the old decorative pseudo-card. */
        .tonyNS .tfDock .mic::before{display:none!important}
        .tonyNS .tfDock .orbstate{margin-bottom:8px!important;transition:transform .24s cubic-bezier(.2,.8,.2,1)!important}
        body:has(.tonyChatTrigger:hover) .tonyNS .tfDock .orbstate,
        body:has(.tonyChatTrigger:focus-visible) .tonyNS .tfDock .orbstate{transform:translateY(-21px)!important}

        .tonyChatTrigger{
          position:fixed;
          z-index:54;
          box-sizing:border-box;
          overflow:hidden;
          border:1px solid rgba(167,139,250,.5);
          border-radius:24px;
          background:#11162a;
          box-shadow:0 10px 24px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.04);
          color:#c8baff;
          font:800 9px/1 ui-monospace,monospace;
          letter-spacing:.14em;
          text-transform:uppercase;
          cursor:pointer;
          clip-path:inset(0 0 calc(100% - 13px) 0 round 24px);
          transform:translateY(-13px);
          transform-origin:50% 100%;
          transition:transform .24s cubic-bezier(.2,.8,.2,1),clip-path .24s cubic-bezier(.2,.8,.2,1),border-color .18s ease,box-shadow .18s ease;
        }
        .tonyChatTrigger span{position:absolute;top:3px;left:0;right:0;text-align:center;white-space:nowrap}
        .tonyChatTrigger:hover,.tonyChatTrigger:focus-visible,.tonyChatTrigger.active{
          transform:translateY(-34px);
          clip-path:inset(0 0 calc(100% - 34px) 0 round 24px);
          border-color:rgba(167,139,250,.82);
          box-shadow:0 14px 32px rgba(0,0,0,.5),0 0 24px rgba(167,139,250,.14),inset 0 1px 0 rgba(255,255,255,.06);
          outline:none;
        }
        body:has(.tonyNS.arriving) .tonyChatTrigger{opacity:0;pointer-events:none}

        .tonyChatPortal{
          position:fixed;
          inset:0;
          z-index:72;
          display:grid;
          place-items:center;
          pointer-events:none;
          background:radial-gradient(circle at 58% 48%,rgba(35,45,80,.14),transparent 42%);
          animation:chatBackdropIn .3s ease both;
        }
        .tonyChatHud{
          position:relative;
          width:min(1060px,calc(100vw - 150px));
          height:min(610px,68vh);
          display:grid;
          grid-template-columns:minmax(190px,260px) minmax(0,1fr);
          align-items:center;
          gap:20px;
          pointer-events:auto;
          transform-origin:56% 50%;
          animation:oldTvOpen .58s cubic-bezier(.16,.84,.24,1) both;
          transition:width .28s cubic-bezier(.2,.8,.2,1),grid-template-columns .28s cubic-bezier(.2,.8,.2,1);
        }
        .tonyChatHud.tonyHidden{
          width:min(860px,calc(100vw - 150px));
          grid-template-columns:minmax(0,1fr);
          justify-content:center;
          transform-origin:50% 50%;
        }
        .chatPanelWrap{
          position:relative;
          min-width:0;
          width:100%;
          height:100%;
          align-self:center;
        }
        .tonyHidden .chatPanelWrap{grid-column:1;justify-self:center}
        .tonyVisualToggle{
          position:absolute;
          z-index:8;
          top:-42px;
          left:50%;
          transform:translateX(-50%);
          display:inline-flex;
          align-items:center;
          justify-content:center;
          gap:8px;
          min-width:116px;
          height:30px;
          padding:0 12px;
          border:1px solid rgba(111,205,235,.24);
          border-radius:999px;
          background:rgba(5,14,24,.9);
          box-shadow:0 8px 24px rgba(0,0,0,.34),0 0 18px rgba(72,191,229,.05),inset 0 1px 0 rgba(255,255,255,.035);
          color:#8fcde2;
          font:800 8px/1 ui-monospace,monospace;
          letter-spacing:.14em;
          text-transform:uppercase;
          cursor:pointer;
          transition:border-color .18s ease,color .18s ease,box-shadow .18s ease,transform .18s ease;
        }
        .tonyVisualToggle:hover,.tonyVisualToggle:focus-visible{
          color:#d9f5ff;
          border-color:rgba(112,219,249,.5);
          box-shadow:0 9px 28px rgba(0,0,0,.4),0 0 22px rgba(78,208,243,.12),inset 0 1px 0 rgba(255,255,255,.05);
          outline:none;
        }
        .tonyVisualToggle:active{transform:translateX(-50%) translateY(1px)}
        .tonyToggleDot{
          width:6px;height:6px;border-radius:50%;background:#65d9e8;box-shadow:0 0 10px rgba(101,217,232,.75)
        }
        .tonyHidden .tonyToggleDot{background:#7f8794;box-shadow:none}
        .tonyTvFlash{
          position:fixed;
          left:50%;
          top:50%;
          width:min(900px,72vw);
          height:2px;
          transform:translate(-50%,-50%) scaleX(0);
          background:#f7fbff;
          box-shadow:0 0 18px #fff,0 0 46px rgba(135,190,255,.9),0 0 90px rgba(167,139,250,.65);
          animation:tvFlash .58s ease-out both;
        }

        .tonyHoloPod{
          position:relative;
          width:min(260px,22vw);
          aspect-ratio:1;
          justify-self:end;
          border:1px solid rgba(111,218,255,.3);
          border-radius:50%;
          overflow:hidden;
          background:radial-gradient(circle at 50% 45%,rgba(81,172,215,.16),rgba(18,32,51,.12) 46%,rgba(2,7,13,.72) 78%);
          box-shadow:inset 0 0 34px rgba(75,191,255,.08),0 0 34px rgba(64,168,220,.08);
          animation:holoPodIn .42s ease .22s both;
        }
        .tonyHoloPod::after{
          content:"";
          position:absolute;
          inset:8%;
          border-radius:50%;
          border:1px dashed rgba(99,219,255,.16);
          animation:holoSpin 12s linear infinite;
        }
        .holoOrbit{position:absolute;inset:22%;border:1px solid rgba(92,213,255,.25);border-radius:50%;transform:rotateX(68deg);box-shadow:0 0 12px rgba(73,203,255,.12)}
        .holoOrbit.orbitB{inset:29%;transform:rotateY(67deg) rotateZ(32deg);border-color:rgba(170,135,255,.24);animation:holoSpinReverse 8s linear infinite}
        .holoGrid{position:absolute;inset:0;opacity:.22;background-image:linear-gradient(rgba(74,204,240,.16) 1px,transparent 1px),linear-gradient(90deg,rgba(74,204,240,.16) 1px,transparent 1px);background-size:18px 18px;mask-image:radial-gradient(circle,#000 22%,transparent 72%)}
        .holoBlock{
          position:absolute;
          left:50%;top:48%;
          width:78px;height:78px;
          transform:translate(-50%,-50%) rotateX(58deg) rotateZ(45deg);
          border:1px solid rgba(114,226,255,.72);
          background:linear-gradient(135deg,rgba(88,210,242,.24),rgba(155,113,255,.11));
          box-shadow:inset 0 0 24px rgba(75,218,255,.18),0 0 28px rgba(79,207,255,.2);
          animation:blockFloat 4.2s ease-in-out infinite;
        }
        .holoBlock .face{position:absolute;display:block;border:1px solid rgba(123,225,255,.34);background:rgba(70,170,210,.06)}
        .holoBlock .one{inset:12px}.holoBlock .two{inset:25px;transform:rotate(45deg)}.holoBlock .three{left:50%;top:-24px;width:1px;height:126px;background:rgba(135,225,255,.22);border:0}
        .holoScan{position:absolute;left:12%;right:12%;height:2px;top:20%;background:rgba(139,232,255,.65);box-shadow:0 0 16px rgba(95,219,255,.7);animation:holoScan 2.8s ease-in-out infinite}
        .holoCaption{position:absolute;left:0;right:0;bottom:13%;text-align:center;color:#77cde7;font:700 9px/1 ui-monospace,monospace;letter-spacing:.18em;text-shadow:0 0 12px rgba(81,203,244,.55)}

        .tonyChatPanel{
          position:relative;
          height:100%;
          min-width:0;
          overflow:hidden;
          display:grid;
          grid-template-rows:auto minmax(0,1fr) auto;
          border:1px solid rgba(119,190,232,.28);
          border-radius:42px;
          background:linear-gradient(180deg,rgba(7,16,27,.86),rgba(5,11,20,.92));
          box-shadow:inset 0 1px 0 rgba(255,255,255,.04),inset 0 0 55px rgba(67,168,224,.035),0 30px 80px rgba(0,0,0,.56),0 0 34px rgba(70,170,230,.07);
          backdrop-filter:blur(16px) saturate(1.2);
        }
        .tonyChatPanel::before{
          content:"";
          position:absolute;
          left:-17px;
          top:50%;
          width:32px;
          height:32px;
          transform:translateY(-50%) rotate(45deg);
          background:rgba(6,14,24,.94);
          border-left:1px solid rgba(119,190,232,.28);
          border-bottom:1px solid rgba(119,190,232,.28);
          z-index:3;
        }
        .tonyHidden .tonyChatPanel::before{display:none}
        .panelScanlines{position:absolute;inset:0;pointer-events:none;opacity:.08;background:repeating-linear-gradient(180deg,rgba(153,220,255,.45) 0,rgba(153,220,255,.45) 1px,transparent 1px,transparent 4px);mix-blend-mode:screen}
        .chatHeader{position:relative;z-index:4;display:flex;align-items:center;justify-content:space-between;padding:20px 24px 16px;border-bottom:1px solid rgba(108,182,224,.12)}
        .chatHeader>div{display:flex;align-items:baseline;gap:12px}.chatHeader b{font:800 13px/1 ui-monospace,monospace;letter-spacing:.15em;color:#cbeeff}.chatHeader span{font:800 8px/1 ui-monospace,monospace;letter-spacing:.14em;color:#50dbc6;padding:4px 7px;border:1px solid rgba(80,219,198,.2);border-radius:999px}
        .chatClose{width:30px;height:30px;border:1px solid rgba(126,194,231,.18);border-radius:10px;background:rgba(8,18,30,.78);color:#8fb5c8;font-size:18px;cursor:pointer}.chatClose:hover{color:#e9f7ff;border-color:rgba(139,207,244,.42)}
        .chatFeed{position:relative;z-index:4;min-height:0;overflow:auto;padding:22px 24px;scrollbar-width:thin;scrollbar-color:rgba(92,170,210,.35) transparent}
        .chatBubble{max-width:78%;margin:0 0 14px;padding:11px 14px;border:1px solid rgba(114,177,211,.12);border-radius:14px;background:rgba(9,19,31,.58);color:#bfd0db;font-size:14px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
        .chatBubble small{display:block;margin-bottom:5px;font:800 8px/1 ui-monospace,monospace;letter-spacing:.12em;color:#65cde9}
        .chatBubble.user{margin-left:auto;background:rgba(31,27,62,.52);border-color:rgba(167,139,250,.18);color:#d7d2eb}.chatBubble.user small{color:#b8a4ff;text-align:right}
        .emptyChat{height:100%;display:grid;place-content:center;text-align:center;color:#6f8b9c}.emptyChat span{font:800 10px/1 ui-monospace,monospace;letter-spacing:.18em;color:#6cd4ea}.emptyChat p{max-width:360px;margin:10px auto 0;font-size:13px;line-height:1.6}
        .chatComposer{position:relative;z-index:4;display:flex;align-items:flex-end;gap:10px;margin:0 20px 20px;padding:9px 9px 9px 14px;border:1px solid rgba(112,187,226,.2);border-radius:18px;background:rgba(4,12,21,.86);box-shadow:inset 0 0 20px rgba(61,160,210,.025)}
        .chatComposer textarea{flex:1;min-width:0;max-height:108px;resize:none;background:transparent;border:0;outline:0;color:#dce8ef;font:500 14px/1.45 Rajdhani,ui-sans-serif,system-ui,sans-serif}.chatComposer textarea::placeholder{color:#637b8b}.chatComposer button{flex:0 0 auto;width:36px;height:36px;border:1px solid rgba(113,204,235,.28);border-radius:12px;background:linear-gradient(135deg,rgba(118,91,216,.9),rgba(45,190,205,.9));color:white;font-size:18px;cursor:pointer}.chatComposer button:disabled{opacity:.38;cursor:not-allowed}

        @keyframes oldTvOpen{
          0%{opacity:0;transform:scaleX(.06) scaleY(.015);filter:brightness(5) contrast(1.5)}
          28%{opacity:1;transform:scaleX(.72) scaleY(.02);filter:brightness(3.5) contrast(1.25)}
          48%{transform:scaleX(1) scaleY(.035);filter:brightness(2.2)}
          76%{transform:scaleX(1) scaleY(1.04);filter:brightness(1.22)}
          100%{opacity:1;transform:scale(1);filter:brightness(1)}
        }
        @keyframes tvFlash{0%,17%{opacity:0;transform:translate(-50%,-50%) scaleX(0)}28%{opacity:1;transform:translate(-50%,-50%) scaleX(.55)}46%{opacity:.95;transform:translate(-50%,-50%) scaleX(1)}70%{opacity:0;transform:translate(-50%,-50%) scaleX(1.08)}100%{opacity:0}}
        @keyframes chatBackdropIn{from{opacity:0}to{opacity:1}}
        @keyframes holoPodIn{from{opacity:0;transform:scale(.82);filter:blur(8px) brightness(2)}to{opacity:1;transform:scale(1);filter:none}}
        @keyframes holoSpin{to{transform:rotate(360deg)}}
        @keyframes holoSpinReverse{to{transform:rotateY(67deg) rotateZ(-328deg)}}
        @keyframes blockFloat{0%,100%{translate:0 0;filter:brightness(.9)}50%{translate:0 -8px;filter:brightness(1.25)}}
        @keyframes holoScan{0%,100%{top:20%;opacity:.18}50%{top:76%;opacity:.75}}

        @media(max-width:900px){
          .tonyChatHud{width:calc(100vw - 36px);height:min(620px,72vh);grid-template-columns:110px minmax(0,1fr);gap:10px}
          .tonyChatHud.tonyHidden{width:min(760px,calc(100vw - 36px));grid-template-columns:minmax(0,1fr)}
          .tonyHoloPod{width:120px;justify-self:start;transform:translateX(18px)}
          .holoCaption{display:none}.holoBlock{width:52px;height:52px}.holoBlock .three{height:90px;top:-19px}
          .tonyChatPanel{border-radius:28px}.chatBubble{max-width:90%}
        }
        @media(max-width:640px){
          .tonyChatHud,.tonyChatHud.tonyHidden{width:calc(100vw - 20px);height:72vh;display:block}.tonyHoloPod{display:none}.tonyChatPanel{height:100%;border-radius:24px}.tonyChatPanel::before{display:none}.chatHeader{padding:16px}.chatFeed{padding:16px}.chatComposer{margin:0 12px 12px}.tonyVisualToggle{display:none}
        }
        @media(prefers-reduced-motion:reduce){
          .tonyChatHud,.tonyTvFlash,.tonyHoloPod,.holoOrbit,.holoBlock,.holoScan,.tonyChatPortal{animation:none!important}
          .tonyChatTrigger,.tonyNS .tfDock .orbstate,.tonyVisualToggle{transition:none!important}
        }
      `}</style>
    </>
  );
}