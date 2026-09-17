// Match the scene background while Next.js fetches the page. The actual planets
// animate in orbit.js once mounted; there is no separate illustrated loader.
export default function TonyLoadingScreen() {
  return (
    <div role="status" aria-label="Preparing Tony" style={{
      position: "fixed", inset: 0, background: "#020409", zIndex: 70,
    }} />
  );
}
