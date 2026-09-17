/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Preserve the original host in role-gate redirects. Next's default URL
  // normalization rewrites 127.0.0.1 to localhost and loses host-only cookies.
  skipMiddlewareUrlNormalize: true,
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:3000"],
      // Media Library uploads videos/images via a server action; the default 1MB
      // body cap is far too small for real creative files.
      bodySizeLimit: "50mb",
    },
  },
  async redirects() {
    return [
      {
        // The Review Gate moved out from under People (6df7954). Without this,
        // an old bookmark hits /access-denied -- the route is gone and nothing
        // grants that path any more -- which reads as "you lost access" rather
        // than "it moved".
        //
        // Config redirects run BEFORE middleware, so this resolves to
        // /reviewgate first and the access check then happens on the real path:
        // HR gets the queue, everyone else still gets /access-denied.
        //
        // Deliberately temporary. A 308 is the honest verb for a rename, but
        // browsers cache it indefinitely and these paths have moved more than
        // once today -- a wrong 308 would be stuck in people's browsers with no
        // way for us to clear it. Switch to permanent once the path settles.
        source: "/people/review-gate",
        destination: "/reviewgate",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
